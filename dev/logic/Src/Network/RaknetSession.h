#pragma once

#include "raknet/include/RakPeerInterface.h"
#include "raknet/include/BitStream.h"
#include "raknet/include/MessageIdentifiers.h"
#include "Network/protocol/DataPacket.h"

class RaknetSession
{
public:
	static constexpr int MAX_CHANNEL = 6;
	// MTU - IPv6 head - UDP head - Raknet head - Raknet Internal head - reserved = 450
	static constexpr int MAX_MESSAGE_SIZE = 576 - 40 - 8 - 4 - 10 - 64;

	enum RaknetMessageId
	{
		ID_NORMAL_DATA = ID_USER_PACKET_ENUM + 1
	};

public:
	RaknetSession(RakNet::RakPeerInterface* rakInterface, RakNet::SystemAddress remote)
		: m_rakInterface(rakInterface)
		, m_remote(remote) {}
	RaknetSession(const RaknetSession&) = delete;
	RaknetSession& operator=(const RaknetSession&) = delete;
	~RaknetSession()
	{
		flush();
		close();
	}

	int sendPacket(const DataPacket& packet)
	{
		RakNet::BitStream serializedData;
		Serializer::write(packet.pid(), &serializedData);
		packet.encode(&serializedData);
		auto dataSize = serializedData.GetNumberOfBytesUsed();

		int channel = packet.channel();
		auto&& buffer = m_bufferedSendData[channel];
		auto currentBufferSize = buffer.GetNumberOfBytesUsed();
		if (currentBufferSize + dataSize > MAX_MESSAGE_SIZE)
		{
			flush(channel);
			currentBufferSize = 0;
		}
		if (currentBufferSize == 0)
		{
			buffer.Write((char)ID_NORMAL_DATA);
		}
		buffer.Write(serializedData);
		if (m_flushEachPacket)
		{
			flush(channel);
		}
		return dataSize;
	}

	// 10096 fork sessions: put every app packet into its OWN RakNet message.
	//
	// The client dispatches one RakNet message at a time and aborts the rest of
	// the message on the first packet it cannot decode (RaknetInstance.cpp:
	// catch -> log "packet decode error" -> return). Batching therefore turns
	// one packet whose layout the fork sizes differently into a desync
	// cascade: the leftover bytes are re-read as fake packet ids, and when a
	// leftover happens to look like 66/67 (PlayerSettlement/GameSettlement)
	// the client opens the post-game screen it then crashes on. With one
	// packet per message a failure only ever drops that single packet.
	void setFlushEachPacket(bool enable) { m_flushEachPacket = enable; }
	bool flushEachPacket() const { return m_flushEachPacket; }

	void flush()
	{
		for (int i = 0; i < MAX_CHANNEL; ++i)
		{
			flush(i);
		}
	}

	void flush(int channel)
	{
		auto&& buffer = m_bufferedSendData[channel];
		if (buffer.GetNumberOfBytesUsed() == 0)
			return;
		PacketReliability reliability = (channel == 0 ? RELIABLE : RELIABLE_ORDERED);
		uint32_t ret = m_rakInterface->Send(&buffer, HIGH_PRIORITY, reliability, channel, m_remote, false);
		buffer.Reset();
	}

	ui64 getSessionId() const
	{
		return RakNet::SystemAddress::ToInteger(m_remote);
	}

	const RakNet::SystemAddress& getRemoteAddress() const { return m_remote; }

	void close()
	{
		if (m_closed)
			return;
		m_rakInterface->CloseConnection(m_remote, true);
		m_closed = true;
	}

private:
	RakNet::SystemAddress m_remote;
	RakNet::RakPeerInterface* m_rakInterface = nullptr;
	bool m_closed = false;
	// See setFlushEachPacket - true for 10096 fork sessions.
	bool m_flushEachPacket = false;
	RakNet::BitStream m_bufferedSendData[MAX_CHANNEL];
};