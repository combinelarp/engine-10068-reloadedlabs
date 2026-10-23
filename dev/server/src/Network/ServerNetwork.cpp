#include "ServerNetwork.h"
#include "ClientPeer.h"
#include "Common.h"
#include "Network/CommonDataDispatch.h"
#include "Core.h"
#include "Setting/MultiLanTipSetting.h"
#include "Network/protocol/AutoRegisterPacketS2C.h"
#include "Network/protocol/DataPacket.h"
#include "Network/protocol/S2CPackets3.h"
#include "Entity/TeleportPositionConverter.h"
#include "Chat/ChatComponent.h"
#include "Object/Root.h"
#include "Util/PlayerPrefs.h"
#include "Network/ForkProtocol.h"

#if LORD_PLATFORM == LORD_PLATFORM_WINDOWS
#define I64FMT "%I64d"
#define U64FMT "%I64u"
#else
#define I64FMT "%lld"
#define U64FMT "%llu"
#endif

using namespace std::placeholders;
ServerNetwork::ServerNetwork(const char *ip, short port)
{
	AutoRegisterS2C s2c;
	registerPacket100(s2c);
	registerPacket200(s2c);
	registerPacket300(s2c);
	registerPacket400(s2c);

	LordNew(CommonDataDispatch);
	LordNew(GameCommon);

	m_networkCore = LORD::make_shared<ServerNetworkCore>(ip, port);
	m_networkRecver = LORD::make_shared<ServerNetworkRecver>();
	m_packetSender = LORD::make_shared<ServerPacketSender>();
	m_commonDataSender = LORD::make_shared<ServerCommonDataSender>();

	std::shared_ptr<CommonPacketSender> pCommon = std::dynamic_pointer_cast<CommonPacketSender>(this->m_packetSender);
	GameCommon::Instance()->setCommonPacketSender(pCommon);

	m_subscriptionGuard.add(BLOCKMAN::ServerNetworkConnSuccEvent::subscribe(std::bind(&ServerNetwork::onServerNetworkConnSucc, this, _1, _2)));
	m_subscriptionGuard.add(BLOCKMAN::ServerNetworkDisconnectEvent::subscribe(std::bind(&ServerNetwork::onServerNetworkDisconnect, this, _1)));
	m_subscriptionGuard.add(BLOCKMAN::ServerNetworkTimeoutEvent::subscribe(std::bind(&ServerNetwork::onServerNetworkTimeout, this, _1)));
}

ServerNetwork::~ServerNetwork(void)
{
	m_subscriptionGuard.unsubscribeAll();
	GameCommon* pGameComm = GameCommon::Instance();
	LordSafeDelete(pGameComm);
	CommonDataDispatch* pDispatch = CommonDataDispatch::Instance();
	LordSafeDelete(pDispatch);
}

bool ServerNetwork::onServerNetworkConnSucc(const ui64 rakssid, const LORD::String& clientIp)
{
	// The earliest possible join marker: the settlement choke has to be armed
	// from the moment the socket exists, because the mode reacts on login and
	// the settlement itself only comes back after the (possibly very slow)
	// reward web call.
	ForkProtocol::notePeerConnected(rakssid);
	ForkProtocol::markPlayerJoined(LORD::Root::Instance()->getCurrentTime());
	auto player = ClientPeer::createPlayer(rakssid, clientIp);
	m_playerMap[rakssid] = player;
	if (PlayerPrefs::Instance()->getBoolPrefs("EnableReconnectNetwork"))
		m_packetRecordMap[rakssid] = LORD::make_shared<PacketRecords>();
	return true;
}

bool ServerNetwork::onServerNetworkDisconnect(const ui64 rakssid) {
	// Clear fork state (classification + login-handshake marker) even when the
	// peer never made it into m_playerMap (e.g. it dropped between Login and the
	// first 179); otherwise a reused raknet id could inherit a stale
	// "handshake already sent" flag and hang on "Loading player data...".
	ForkProtocol::clearSession(rakssid);
	ForkProtocol::notePeerGone(rakssid);
	auto delPlayer = m_playerMap.find(rakssid);
	if (delPlayer != m_playerMap.end())
	{
		LordLogInfo("handleConnectEvent RaknetInstance::emDisconnect with session id=" U64FMT, rakssid);
		onDisconnect(delPlayer->second);
	}
	else
	{
		LordLogError("deleteSession but can not find player with session id=" U64FMT, rakssid);
	}
	return true;
}

bool ServerNetwork::onServerNetworkTimeout(const ui64 rakssid) {
	ForkProtocol::notePeerGone(rakssid);
	auto timeoutPlayer = m_playerMap.find(rakssid);
	if (timeoutPlayer != m_playerMap.end())
	{
		LordLogInfo("handleConnectEvent RaknetInstance::emConnectTimeout with session id=" U64FMT, rakssid);
		onConnectTimeout(timeoutPlayer->second);
	}
	return true;
}

String ServerNetwork::getPlayerIp(const ui64 rakssId)
{
	auto iter = m_playerMap.find(rakssId);
	if (iter != m_playerMap.end())
	{
		return iter->second->getClientIp();
	}
	else
	{
		return "";
	}
}

void ServerNetwork::host(ui32 maxSession)
{
	m_networkCore->getRaknetInstance()->recv([this](std::shared_ptr<DataPacket> packet) {m_networkRecver->recvPacket(packet); });
	m_networkCore->getRaknetInstance()->setHeartbeatCallback([]() { Server::Instance()->setRaknetState(); });
	
	m_networkCore->host(maxSession);
}

namespace
{
	// 10096 fork safety net - last line of defence against the SPURIOUS
	// post-game UI.
	//
	// The settlement packets (S2C 54 Settlement, 66 PlayerSettlement,
	// 67 GameSettlement, 164 GameSettlementExtra) open gui_deadSummary /
	// gui_finalSummary in the client (S2CPlayerActionPacketHandles.cpp:924 and
	// :938 -> ReceiveDeadSummaryEvent / ReceiveFinalSummaryEvent). The game-mode
	// scripts fire them at an ALREADY-PRESENT player the moment ANOTHER client
	// joins - a bogus "match over" reaction to the join - and closing that
	// screen crashes the prebuilt 10096 client. Every sender path (a sender, a
	// Lua HostApi binding, the multicast helper, the reconnect history replay)
	// funnels through this choke.
	//
	// The SAME post-game screen also arrives through the generic key/value
	// channel: S2CPacketServerCommonData carries @c name/@c key/@c data and the
	// client hands it to CommonDataDispatch -> "Lua" -> ServerCommonDataEvent
	// (S2CCommonDataPacketHandles.cpp:134), whose client-side subscribers open
	// gui_deadSummary / gui_finalSummary. The game-mode Lua scripts reach it
	// with PacketSender:sendLuaCommonData(rakssid, "<settlement key>", data)
	// - e.g. "DeadSummaryData", "SingleSettlement", "KeyAdSettlementSingle"
	// (BedWar), "DeathSettlement" (WalkingDead).
	//
	// The screen must appear when the match REALLY ends (the user asked for
	// this), and must not appear on join. A genuine match-over never coincides
	// with a join, so a settlement is suppressed for EVERY session while SOME
	// session is still in its join pipeline (connected, not yet spawned) OR a
	// join stage happened within ForkProtocol::kJoinSettlementGraceMs. Outside
	// both the packet is forwarded untouched. Every other packet type - and
	// every other ServerCommonData key (JoinGameStatus, ServerInfo, exchange,
	// records, lottery, ...) - passes through unconditionally.
	//
	// Fork classification is deliberately NOT consulted here. Both the 10096
	// fork client and the stock client were still getting the screen because
	// isForkSession() was false for each of them (never classified, or cleared
	// by clearSession on the previous disconnect), so the old "stock sessions
	// keep the stock behaviour" early-out forwarded the packet to both. The
	// symptom is a join problem, not a protocol problem - key the choke off
	// the join state alone.
	bool isForkBlockedCommonDataKey(const String& key)
	{
		auto lower = [](char c) -> char
		{
			return (c >= 'A' && c <= 'Z') ? static_cast<char>(c - 'A' + 'a') : c;
		};
		auto containsNoCase = [&key, &lower](const char* needle)
		{
			const String lowered(needle);
			const size_t n = lowered.size();
			if (key.size() < n)
			{
				return false;
			}
			for (size_t i = 0; i + n <= key.size(); ++i)
			{
				size_t j = 0;
				for (; j < n; ++j)
				{
					if (lower(key[i + j]) != lowered[j])
					{
						break;
					}
				}
				if (j == n)
				{
					return true;
				}
			}
			return false;
		};
		auto equalsNoCase = [&key, &lower](const char* needle)
		{
			const String expected(needle);
			if (key.size() != expected.size())
			{
				return false;
			}
			for (size_t i = 0; i < key.size(); ++i)
			{
				if (lower(key[i]) != lower(expected[i]))
				{
					return false;
				}
			}
			return true;
		};

		if (containsNoCase("settlement") || containsNoCase("summary"))
		{
			return true;
		}

		// Result screens whose key does not contain "settlement"/"summary".
		// S2CCommonDataPacketHandles.cpp:310/:327 maps these straight onto the
		// post-game layouts (PIXEL_GUN_RESULT / PIXEL_CHICKEN_AWARD) instead of
		// routing them through ServerCommonDataEvent, so the substring test
		// above never saw them.
		static const char* const kResultScreenKeys[] =
		{
			"ShowGameResult", "GameResultExtra", "1v1ResultData",
			"PersonResultData", "TeamResultData", "ChickenResultData",
			"ShowChickenResult"
		};
		for (size_t i = 0; i < sizeof(kResultScreenKeys) / sizeof(kResultScreenKeys[0]); ++i)
		{
			if (equalsNoCase(kResultScreenKeys[i]))
			{
				return true;
			}
		}
		return false;
	}

	// Any session - fork or stock - is subject to this choke, and every other
	// packet type passes through untouched: the anti-cheat S2CGameover and
	// GameStatus are both forwarded.
	//
	// This is consulted for EVERY outbound packet, so the pid gate runs first
	// and the join state (three mutex reads) is only sampled once we know the
	// packet can actually open the post-game screen.
	bool isForkBlockedResultPacket(std::shared_ptr<DataPacket> packet, ui64 rakssid)
	{
		if (!packet)
		{
			return false;
		}

		const S2CPacketType pid = static_cast<S2CPacketType>(packet->pid());
		// Screens that paint the end-of-match result / score menu.
		// Client side: pid 54 -> shellInterface->gameSettlement,
		// pid 66 -> ReceiveDeadSummaryEvent -> gui_deadSummary,
		// pid 67 -> PlayEndingAnimation/ReceiveFinalSummaryEvent -> gui_finalSummary,
		// pid 164 -> final-summary extra, all in
		// S2CPlayerActionPacketHandles.cpp:539/:917/:928/:2166.
		const bool isSettlementPid =
			pid == S2CPacketType::Settlement ||
			pid == S2CPacketType::PlayerSettlement ||
			pid == S2CPacketType::GameSettlement ||
			pid == S2CPacketType::GameSettlementExtra;
		// The live leaderboard rows. Two packets paint it:
		//  - pid 125 S2CPacketUpdateRealTimeRankInfo -> RootGuiLayout::
		//    updateRealTimeRankData -> gui_realTimeRank (the panel the client
		//    re-requests every 10s while it is visible). The mode's match tick
		//    keeps pushing it after the match is over, so a fresh joiner is
		//    handed the previous match's board.
		//  - pid 100 S2CPacketRankData -> RankManager::setRankInfo, the rank-NPC
		//    board. TinyTown pushes it to the joiner only, right after the
		//    async loadMyManorRank HTTP response comes back
		//    (TinyTown\main\listener\PlayerListener.lua onPlayerReady ->
		//    RankListener.onLoadMyManorRank -> ManorNpcConfig:sendRankData), so
		//    it is a pure join reaction and it is the packet that was still
		//    reaching one of the two clients.
		// Neither re-arms the window: both are pushed continuously by the mode,
		//    so re-arming would hold it open for the whole match and the
		//    genuine end screen would be lost. Both are safe to drop for the
		//    same reason - the client re-requests pid 125 by itself while pid
		//    100 is resent whenever the rank data changes.
		const bool isRankPid =
			pid == S2CPacketType::UpdateRealTimeRankInfo ||
			pid == S2CPacketType::RankData;

		std::shared_ptr<S2CPacketServerCommonData> common;
		if (!isSettlementPid && !isRankPid)
		{
			if (pid != S2CPacketType::ServerCommonData)
			{
				return false;
			}
			common = std::dynamic_pointer_cast<S2CPacketServerCommonData>(packet);
			if (!common || !isForkBlockedCommonDataKey(common->key))
			{
				return false;
			}
		}

		// Only the spurious, join-triggered post-game packet is dropped. A
		// genuine match-over happens with nobody joining, so it is forwarded
		// and the client still gets its real end screen.
		//
		// Either half is enough on its own: the join pipeline covers the whole
		// load of the other client AND the asynchronous RewardManager ->
		// WebService call that the settlement is queued behind (with no
		// reachable reward backend that call only returns after the HTTP
		// timeout, which is what let the old 20s login-based window expire
		// before the packet ever left the server); the time window covers the
		// reaction that lands just after the joining player has spawned.
		const ui32 now = LORD::Root::Instance()->getCurrentTime();
		const ui32 lastJoinAge = ForkProtocol::lastJoinAgeMs(now);
		const bool joinPipeline = ForkProtocol::joinPipelineActive();
		const bool joinTriggeredSettlement =
			joinPipeline || ForkProtocol::settlementSuppressedByJoinWindow(now);

		if (joinTriggeredSettlement)
		{
			// Re-arm so a burst of settlements (one per player, each behind its
			// own web call) is caught as a whole, not just the first one.
			// Never on realtime-rank data: the mode's match tick pushes that
			// continuously, so re-arming on it would hold the window open for
			// the whole match and the genuine end screen would be lost.
			if (!isRankPid)
			{
				ForkProtocol::extendJoinWindow(now);
			}
			if (common)
			{
				LordLogWarning("[FORK] join-triggered settlement common-data key '%s' (name '%s') suppressed for session " U64FMT
					" (fork=%d, joinPipeline=%d, lastJoinAgeMs=%u)",
					common->key.c_str(), common->name.c_str(), rakssid,
					ForkProtocol::isForkSession(rakssid) ? 1 : 0,
					joinPipeline ? 1 : 0, lastJoinAge);
			}
			else
			{
				LordLogWarning("[FORK] join-triggered packet pid %u suppressed for session " U64FMT
					" (fork=%d, joinPipeline=%d, lastJoinAgeMs=%u)",
					static_cast<unsigned>(packet->pid()), rakssid,
					ForkProtocol::isForkSession(rakssid) ? 1 : 0,
					joinPipeline ? 1 : 0, lastJoinAge);
			}
			return true;
		}

		if (common)
		{
			LordLogInfo("[FORK] settlement common-data key '%s' forwarded to session " U64FMT
				" (fork=%d, joinPipeline=0, lastJoinAgeMs=%u)",
				common->key.c_str(), rakssid,
				ForkProtocol::isForkSession(rakssid) ? 1 : 0, lastJoinAge);
		}
		else
		{
			LordLogInfo("[FORK] settlement packet pid %u forwarded to session " U64FMT
				" (fork=%d, joinPipeline=0, lastJoinAgeMs=%u)",
				static_cast<unsigned>(packet->pid()), rakssid,
				ForkProtocol::isForkSession(rakssid) ? 1 : 0, lastJoinAge);
		}
		return false;
	}
}

void ServerNetwork::sendPacket(std::shared_ptr<DataPacket> packet, ui64 rakssid)
{
	if (isForkBlockedResultPacket(packet, rakssid))
	{
		return;
	}
	if (ForkProtocol::isForkSession(rakssid))
	{
		// One app packet per RakNet message for fork sessions. The 10096
		// client aborts the rest of a message on the first packet it cannot
		// decode, and RaknetSession batches every same-channel packet into one
		// message - so a single undecodable packet desynced the whole batch
		// and the leftover bytes got re-read as fake packet ids (66/67 open
		// the post-game screen the prebuilt client crashes on).
		m_networkCore->getRaknetInstance()->isolatePackets(rakssid, true);
	}
	recordPacket(packet, rakssid);
	auto record = m_reconnectRecordMap.find(rakssid);
	if (record != m_reconnectRecordMap.end() && record->second->isReconnectSuccess)
		record->second->historyDataPackets.push_back(packet);
	else
		m_networkCore->getRaknetInstance()->send(packet, rakssid);
}

void ServerNetwork::flush()
{
	m_networkCore->getRaknetInstance()->flush();
}

void ServerNetwork::deferLoginProcess(ui64 platformUserId, std::shared_ptr<DataPacket> packet) {
	m_networkRecver->deferLoginProcess(platformUserId, packet);
}

bool ServerNetwork::hasBeenDeferredLogin(ui64 platformUserId) {
	return m_networkRecver->hasBeenDeferredLogin(platformUserId);
}

std::shared_ptr<ClientPeer> ServerNetwork::findPlayerByRakssid(ui64 ssid)
{
	std::shared_ptr<ClientPeer> pret;
	auto it = m_playerMap.find(ssid);
	if (it != m_playerMap.end())
	{
		return it->second;
	}
	return pret;
}

std::shared_ptr<ClientPeer> ServerNetwork::findPlayerByPlatformUserId(ui64 userId)
{
	for (auto player : m_playerMap)
	{
		if (player.second->getPlatformUserId() == userId)
		{
			return player.second;
		}
	}
	return nullptr;
}

std::set<ui64> ServerNetwork::getPlatformUserIds()
{
	std::set<ui64> platformUserIds;
	for (auto player : m_playerMap)
	{
		platformUserIds.insert(player.second->getPlatformUserId());
	}
	return platformUserIds;
}

int ServerNetwork::getPlayerNumber()
{
	return m_playerMap.size(); 
}

void ServerNetwork::broadCastEntityPacket(std::shared_ptr<DataPacket> packet, ui64 runtimeId)
{
	for (auto player : m_playerMap)
	{
		if (player.second->hasLogon() && !(player.second->getEntityRuntimeID() == runtimeId))
		{
			sendPacket(packet, player.second->getRakssid());
		}
	}
}

void ServerNetwork::broadCastEntityPacket(std::shared_ptr<DataPacket> packet)
{
	for (auto player : m_playerMap)
	{
		if (player.second->hasLogon())
		{
			sendPacket(packet, player.second->getRakssid());
		}
	}
}

template<typename RaknetIdList>
void ServerNetwork::multicastEntityPacket(std::shared_ptr<DataPacket> packet, const RaknetIdList & targets)
{
	for (const auto& targetId : targets)
	{
		auto iter = m_playerMap.find(targetId);
		if (iter == m_playerMap.end())
		{
			LordLogWarning("raknet id %llu is not in m_playerMap", targetId);
			continue;
		}
		if (iter->second->hasLogon() && !isForkBlockedResultPacket(packet, targetId))
		{
			if (ForkProtocol::isForkSession(targetId))
			{
				m_networkCore->getRaknetInstance()->isolatePackets(targetId, true);
			}
			m_networkCore->getRaknetInstance()->send(packet, targetId);
		}
	}
}

template void ServerNetwork::multicastEntityPacket(std::shared_ptr<DataPacket> packet, const LORD::vector<ui64>::type & targets);

void ServerNetwork::foreachPlayer(std::function<void(std::shared_ptr<ClientPeer>)> callBack)
{
	for (auto player : m_playerMap)
	{
		callBack(player.second);
	}
}

void ServerNetwork::onDisconnect(std::shared_ptr<ClientPeer>& clientPeer)
{
	TeleportPositionConverter::ClearServerSideAnchors(clientPeer->getRakssid());
	m_networkRecver->clearDeferLogin(clientPeer->getPlatformUserId());
	auto rakssid = clientPeer->getRakssid();
	clientPeer->logout();
	// Forget the fork classification and the "login handshake already sent"
	// marker, otherwise a fresh 10096 join that RakNet pins to the same
	// SystemAddress integer would never be answered again (client stuck on
	// "Loading player data..."). See ForkProtocol::clearSession.
	ForkProtocol::clearSession(rakssid);
	ForkProtocol::notePeerGone(rakssid);
	clearPlayerCache(rakssid);
}

void ServerNetwork::onConnectTimeout(std::shared_ptr<ClientPeer>& clientPeer)
{
	if (!PlayerPrefs::Instance()->getBoolPrefs("EnableReconnectNetwork"))
	{
		onDisconnect(clientPeer);
		return;
	}

	std::shared_ptr<ReconnectRecord> saveRecord = NULL;
	for (auto record : m_reconnectRecordMap)
	{
		if (record.second->reconnectUserId == clientPeer->getPlatformUserId())
		{
			saveRecord = record.second;
			saveRecord->isReconnectSuccess = false;
			m_reconnectRecordMap.erase(record.first);
			break;
		}
	}
	if (saveRecord == NULL)
		saveRecord = LORD::make_shared<ReconnectRecord>();;
	saveRecord->reconnectUserId = clientPeer->getPlatformUserId();
	if (saveRecord->startReconnectTime == 0)
		saveRecord->startReconnectTime = LORD::Root::Instance()->getCurrentTime();
	m_reconnectRecordMap[clientPeer->getRakssid()] = saveRecord;
}

void ServerNetwork::clearPlayerCache(ui64 rakssid)
{
	if (m_reconnectRecordMap.find(rakssid) != m_reconnectRecordMap.end())
		m_reconnectRecordMap.erase(rakssid);
	if (m_packetRecordMap.find(rakssid) != m_packetRecordMap.end())
		m_packetRecordMap.erase(rakssid);
	m_clientPingMap.erase(rakssid);
	m_playerMap.erase(rakssid);
}

void ServerNetwork::recordPacket(std::shared_ptr<DataPacket> packet, ui64 rakssid)
{
	auto records = m_packetRecordMap.find(rakssid);
	if (records != m_packetRecordMap.end())
	{
		PacketRecord record;
		record.sendTime = LORD::Root::Instance()->getCurrentTime();
		record.packet = packet;
		records->second->records.push_back(record);
	}
}

void ServerNetwork::closeSession(std::shared_ptr<ClientPeer>& clientPeer)
{
	m_networkCore->closeSession(clientPeer->getRakssid());
	onDisconnect(clientPeer);
}

void ServerNetwork::tick()
{
	tickReconnect();
	tickCheckPacketRecord();
	m_networkRecver->recvTick();
}

void ServerNetwork::tickReconnect()
{
	ui32 currentTime = LORD::Root::Instance()->getCurrentTime();
	int maxReconnectTime = 60000;
	for (auto record = m_reconnectRecordMap.begin(); record != m_reconnectRecordMap.end(); )
	{
		if (record->second == NULL)
		{
			record = m_reconnectRecordMap.erase(record);
			continue;
		}

		if (record->second->isReconnectSuccess)
		{
			// Resend historical data packets after successful reconnection
			int count = 0;
			while (count < 100)
			{
				if (record->second->historyDataPackets.empty())
					break;
				count++;
				auto packet = record->second->historyDataPackets.begin();
				if (!isForkBlockedResultPacket(*packet, record->first))
				{
					if (ForkProtocol::isForkSession(record->first))
					{
						m_networkCore->getRaknetInstance()->isolatePackets(record->first, true);
					}
					m_networkCore->getRaknetInstance()->send(*packet, record->first);
				}
				record->second->historyDataPackets.pop_front();;
			}

			if (record->second->historyDataPackets.empty())
			{
				record = m_reconnectRecordMap.erase(record);
			}
			else
			{
				record++;
			}
			continue;
		}

		if (currentTime - record->second->startReconnectTime >= maxReconnectTime)
		{
			// kick out the server in more than 60 seconds
			auto clientPeer = findPlayerByRakssid(record->first);
			record = m_reconnectRecordMap.erase(record);
			if (clientPeer) 
			{
				LordLogInfo("[RECONNECT_FAILED]ServerNetwork --> player reconnect failed(60s), userId:" U64FMT " rakssid:" U64FMT,
					clientPeer->getPlatformUserId(), clientPeer->getRakssid());
				closeSession(clientPeer);
			}
		}
		else
		{
			record++;
		}
	}
}

void ServerNetwork::tickCheckPacketRecord()
{
	ui32 currentTime = LORD::Root::Instance()->getCurrentTime();
	for (auto packetRecord : m_packetRecordMap)
	{
		while (true)
		{
			auto reconnectRecord = m_reconnectRecordMap.find(packetRecord.first);
			if (reconnectRecord != m_reconnectRecordMap.end())
				break;
			if (packetRecord.second->records.empty())
				break;
			auto record = packetRecord.second->records.begin();
			if (currentTime - record->sendTime < 10000)
				break;
			packetRecord.second->records.pop_front();
		}
	}
}

bool ServerNetwork::checkReconnect(ui64 platformUserId, ui64 rakssid)
{
	for (auto record = m_reconnectRecordMap.begin(); record != m_reconnectRecordMap.end(); record++)
	{
		if (record->second->reconnectUserId != platformUserId)
			continue;
		record->second->isReconnectSuccess = true;
		if (record->first != rakssid) // Use different ip to reconnect
		{
			m_reconnectRecordMap[rakssid] = record->second;
			auto packetRecords = m_packetRecordMap.find(record->first);
			if (packetRecords != m_packetRecordMap.end())
			{
				for (auto packetRecord : packetRecords->second->records)
				{
					record->second->historyDataPackets.push_back(packetRecord.packet);
				}
			}
		}
	}
	auto oldClientPeer = findPlayerByPlatformUserId(platformUserId);
	if (!oldClientPeer)
		return false;
	auto newClientPeer = findPlayerByRakssid(rakssid);
	if (newClientPeer)
	{
		newClientPeer->reconnect(oldClientPeer);
	}
	m_reconnectRecordMap.erase(oldClientPeer->getRakssid());
	return true;
}

bool ServerNetwork::kickOldLogin(ui64 platformUserId, ui64 rakssid)
{
	std::vector<std::shared_ptr<ClientPeer>> clientPeers;
	for (auto clientPeer : m_playerMap)
	{
		if (clientPeer.second->getPlatformUserId() == platformUserId 
			&& clientPeer.second->getRakssid() != rakssid )
		{
			clientPeers.push_back(clientPeer.second);
		}
	}
	for (auto clientPeer : clientPeers)
	{
		LordLogWarning("kickOldLogin of same platform uid " U64FMT ", ServerNetwork clean up, raknet id " U64FMT ", name:%s", 
			platformUserId, clientPeer->getRakssid(), clientPeer->getName().c_str());
		ServerNetwork::Instance()->getSender()->sendLoginResult(clientPeer->getRakssid(), 
			(int32_t)NETWORK_DEFINE::PacketLoginResult::emErrBeKicked);
		m_kickingOut = true;
		closeSession(clientPeer);
		m_kickingOut = false;
	}
	return clientPeers.size() > 0;
}

void ServerNetwork::closeAllSession()
{
	std::vector<std::shared_ptr<ClientPeer>> clientArr;
	for (auto i_c : m_playerMap) {
		if (i_c.second->hasLogon()) {
			clientArr.push_back(i_c.second);
		}
	}

	for (auto c : clientArr) {
		LordLogWarning("closeAllSession because server quitting, close session for uid " U64FMT ", raknet id " U64FMT ", name:%s", 
			c->getPlatformUserId(), c->getRakssid(), c->getName().c_str());

		closeSession(c);
	}
}

void ServerNetwork::broadCastMsg(ui64 targetId/*ssid*/, ui8 type, i32 time, const char *msg)
{
	ChatComponentNotification::Type chatType = static_cast<ChatComponentNotification::Type>(type);
	auto notify = LORD::make_shared<ChatComponentNotification>(String(msg), time, chatType);

	if (targetId == 0)
	{
		m_packetSender->sendNotification(notify);
	}
	else
	{
		m_packetSender->sendNotification(targetId, notify);
	}
}

void ServerNetwork::broadCastMsgByType(ui64 targetId, ui8 type, i32 time, int msgType, const char* args)
{
	std::shared_ptr<ChatComponentNotification> notify = nullptr;

	if (targetId == 0)
	{
		for (auto player : m_playerMap)
		{
			if (player.second->hasLogon())
			{
				String lan = player.second->getLanguage();
				notify = getBroadCastMsgNotify(type, time, lan, msgType, args);
				ServerNetwork::Instance()->getSender()->sendNotification(player.second->getRakssid(), notify);
			}
		}
	}
	else
	{
		auto peer = findPlayerByRakssid(targetId);
		if (peer)
		{
			String lan = peer->getLanguage();
			notify = getBroadCastMsgNotify(type, time, lan, msgType, args);
			ServerNetwork::Instance()->getSender()->sendNotification(targetId, notify);
		}
	}
}

void ServerNetwork::sendGameOver(ui64 rakssid, int msgType, int code)
{
	auto player = findPlayerByRakssid(rakssid);
	if (player)
	{
		LordLogInfo("sendGameOver,platform uid " U64FMT ", name %s, rakssId " U64FMT,
			player->getPlatformUserId(), player->getName().c_str(), rakssid);
		String lan = player->getLanguage();
		std::string msg = MultiLanTipSetting::getMessage(lan, msgType, "");
		ServerNetwork::Instance()->getSender()->sendGameover(rakssid, msg.c_str(), code);
	}
	else
	{
		LordLogError("sendGameOver fail, can't find player, rakssId " U64FMT, rakssid);
	}
}

void ServerNetwork::sendGameOverByPlatformUserId(ui64 platformUserId, const String& overMessage, int code)
{
	auto player = findPlayerByPlatformUserId(platformUserId);
	if (player)
	{
		LordLogInfo("sendGameOverByPlatformUserId,platform uid " U64FMT ", name %s, rakssId " U64FMT ", code=%d",
			player->getPlatformUserId(), player->getName().c_str(), player->getRakssid(), code);

		ServerNetwork::Instance()->getSender()->sendGameover(player->getRakssid(), overMessage.c_str(), code);
	}
	else
	{
		LordLogError("sendGameOverByPlatformUserId fail, can't find player, platformUserId " U64FMT, platformUserId);
	}
}

std::shared_ptr<ChatComponentNotification> ServerNetwork::getBroadCastMsgNotify(ui8 type, i32 time, String& lanType, int msgType, const char* args)
{
	std::string msg = MultiLanTipSetting::getMessage(lanType, msgType, args);
	ChatComponentNotification::Type chatType = static_cast<ChatComponentNotification::Type>(type);
	return LORD::make_shared<ChatComponentNotification>(String(msg.c_str()), time, chatType);
}

void ServerNetwork::broadCastGameTipByType(ui64 targetId, ui8 type, i32 time, int msgType, const char * args)
{
	ChatComponentNotification::Type chatType = static_cast<ChatComponentNotification::Type>(type);
	ChatComponentNotification *notify = LordNew ChatComponentNotification(String(args), time, chatType);

	ServerNetwork::Instance()->getSender()->sendGameTipNotification(targetId, msgType, notify);
}

void ServerNetwork::broadCastServerQuitting(const char * msg)
{
	for (auto player : m_playerMap)
	{
		if (player.second->hasLogon())
		{
			m_packetSender->sendGameover(player.second->getRakssid(), msg, 11);
		}
	}
}

ServerNetwork::SpeedCheatType ServerNetwork::speedCheatCheck(
	const ui64 raknetId, ui32 clientRecvLastPingAckTime, ui32 clientSendPingTime, ui32 currServerTime)
{
	ClientPing clientPing;
	if (m_clientPingMap.find(raknetId) != m_clientPingMap.end()) {
		clientPing = m_clientPingMap[raknetId];
	}

	PingInfo firstPing = clientPing.firstPing;
	PingInfo secondPing = clientPing.secondPing;
	if (firstPing.clientSendPingTime == 0) {
		// first ping, ignore clientRecvLastPingAckTime
		firstPing.clientSendPingTime = clientSendPingTime;
		firstPing.serverSendPingTime = currServerTime;

		clientPing.firstPing = firstPing;
	}
	else if (secondPing.clientSendPingTime == 0) {
		// second ping
		firstPing.clientRecvPingAckTime = clientRecvLastPingAckTime;
		secondPing.clientSendPingTime = clientSendPingTime;
		secondPing.serverSendPingTime = currServerTime;

		clientPing.firstPing = firstPing;
		clientPing.secondPing = secondPing;
	}
	else if (secondPing.clientRecvPingAckTime == 0) {
		// after the second ping
		secondPing.clientRecvPingAckTime = clientRecvLastPingAckTime;
        /*
		LordLogInfo("ServerNetwork::speedCheatCheck, rakssId " U64FMT ", firstPing{clientSend:%u, serverSend:%u, clientRecvAck:%u},"
			"secondPing{clientSend:%u, serverSend:%u, clientRecvAck:%u},"
			"correct case: %u(t6-t1) > %u(t5-t2) > %u(t4-t3)", raknetId,
			firstPing.clientSendPingTime, firstPing.serverSendPingTime, firstPing.clientRecvPingAckTime,
			secondPing.clientSendPingTime, secondPing.serverSendPingTime, secondPing.clientRecvPingAckTime,
			(secondPing.clientRecvPingAckTime - firstPing.clientSendPingTime),
			(secondPing.serverSendPingTime - firstPing.serverSendPingTime),
			(secondPing.clientSendPingTime - firstPing.clientRecvPingAckTime));
        */

		ServerNetwork::PingInfo nextPing;
		nextPing.clientSendPingTime = clientSendPingTime;
		nextPing.serverSendPingTime = currServerTime;

		// check speed up
		if ((secondPing.serverSendPingTime - firstPing.serverSendPingTime + 2500) <
				(secondPing.clientSendPingTime - firstPing.clientRecvPingAckTime)) 
		{
			LordLogError("ServerNetwork::speedCheatCheck, speed up detected, rakssId " U64FMT 
				", firstPing{clientSend:%u, serverSend:%u, clientRecvAck:%u},"
				"secondPing{clientSend:%u, serverSend:%u, clientRecvAck:%u},"
				"correct case: %u(t6-t1) > %u(t5-t2) > %u(t4-t3), but (t5-t2) < (t4-t3)", raknetId,
				firstPing.clientSendPingTime, firstPing.serverSendPingTime, firstPing.clientRecvPingAckTime,
				secondPing.clientSendPingTime, secondPing.serverSendPingTime, secondPing.clientRecvPingAckTime,
				(secondPing.clientRecvPingAckTime - firstPing.clientSendPingTime),
				(secondPing.serverSendPingTime - firstPing.serverSendPingTime),
				(secondPing.clientSendPingTime - firstPing.clientRecvPingAckTime));

			return SpeedCheatType::CHEAT_SPEED_UP;
		}

		// check slow down
		if ((secondPing.clientRecvPingAckTime - firstPing.clientSendPingTime + 4000) <
				(secondPing.serverSendPingTime - firstPing.serverSendPingTime)) 
		{
			LordLogError("ServerNetwork::speedCheatCheck, slow down detected, rakssId " U64FMT 
				", firstPing{clientSend:%u, serverSend:%u, clientRecvAck:%u},"
				"secondPing{clientSend:%u, serverSend:%u, clientRecvAck:%u},"
				"correct case: %u(t6-t1) > %u(t5-t2) > %u(t4-t3), but (t6-t1) < (t5-t2)", raknetId,
				firstPing.clientSendPingTime, firstPing.serverSendPingTime, firstPing.clientRecvPingAckTime,
				secondPing.clientSendPingTime, secondPing.serverSendPingTime, secondPing.clientRecvPingAckTime,
				(secondPing.clientRecvPingAckTime - firstPing.clientSendPingTime),
				(secondPing.serverSendPingTime - firstPing.serverSendPingTime),
				(secondPing.clientSendPingTime - firstPing.clientRecvPingAckTime));

			return SpeedCheatType::CHEAT_SLOW_DOWN;
		}

		clientPing.firstPing = secondPing;
		clientPing.secondPing = nextPing;
	}

	m_clientPingMap[raknetId] = clientPing;

	return SpeedCheatType::CHEAT_SPEED_NONE;
}

String ServerNetwork::getSendTotalPacketInfo()
{
	auto raknetInstance = m_networkCore->getRaknetInstance();
	return raknetInstance->getSendTotalPacketInfo();
}
