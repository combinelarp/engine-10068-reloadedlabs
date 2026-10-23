#include "EntityPlayerMP.h"

#include "EntityTrackerEntry.h"
#include "Entity/Entity.h"
#include "Entity/EntityArrow.h"
#include "Entity/EntityThrowable.h"
#include "Entity/EntityMerchant.h"
#include "Entity/EntityRankNpc.h"
#include "Entity/EntityBlockmanEmpty.h"
#include "Server.h"
#include "Network/ServerPacketSender.h"
#include "Network/ServerNetwork.h"
#include "Network/ClientPeer.h"
#include "RoomManager.h"
#include "CommodityManager.h"
#include "Entity/EntityVehicle.h"
#include "Entity/EntityAircraft.h"
#include "Entity/EntityActorNpc.h"
#include "Script/GameServerEvents.h"
#include "Entity/EntitySessionNpc.h"
#include "Entity/EntityBlockman.h"
#include "Entity/EntityActorCannon.h"
#include "Entity/EntityBuildNpc.h"
#include "Entity/EntityLandNpc.h"
#include "Entity/EntityBulletin.h"
#include "Entity/EntityDecoration.h"
#include "Blockman/Entity/EntityBirdAI.h"
#include "Entity/EntityFlyingMount.h"
#include "Entity/EntityFloatingMount.h"
#include "Util/PlayerPrefs.h"
#include "Network/ForkProtocol.h"

#if LORD_PLATFORM == LORD_PLATFORM_WINDOWS
#define I64FMT "%I64d"
#define U64FMT "%I64u"
#else
#define I64FMT "%lld"
#define U64FMT "%llu"
#endif

namespace BLOCKMAN
{
	EntityTrackerEntry::EntityTrackerEntry(Entity* pEntity, int range, int frequency, bool sendVelocity)
	{
		reinit(pEntity, range, frequency, sendVelocity);
	}

	void EntityTrackerEntry::reinit(Entity* pEntity, int range, int frequency, bool sendVelocity)
	{
		myEntity = pEntity;
		m_blocksDistanceThreshold = range;
		m_updateFrequency = frequency;
		sendVelocityUpdates = sendVelocity;
		// all the position is scale by 32. server use INT type.
		/*if (dynamic_cast<EntityPlayer*>(myEntity)) {
			LordLogInfo("EntityTrackerEntry construct, position=(%f,%f,%f), id=%d", pEntity->position.x,
				pEntity->position.y, pEntity->position.z, pEntity->entityId);
		}*/
		lastScaledPos.x = int(Math::Floor(pEntity->position.x * 32.0f));
		lastScaledPos.y = int(Math::Floor(pEntity->position.y * 32.0f));
		lastScaledPos.z = int(Math::Floor(pEntity->position.z * 32.0f));
		// lastYaw = int(Math::Floor(pEntity->rotationYaw * 256.0F / 360.0F));
		// lastPitch = int(Math::Floor(pEntity->rotationPitch * 256.0F / 360.0F));
		// lastHeadMotion = int(Math::Floor(pEntity->getRotationYawHead() * 256.0F / 360.0F));

		lastYaw = pEntity->rotationYaw;
		lastPitch = pEntity->rotationPitch;
		lastHeadMotion = pEntity->getRotationYawHead();

		motion = Vector3::ZERO;
		ticks = 0;
		position = Vector3::ZERO;
		isDataInitialized = false;
		playerEntitiesUpdated = false;
		ticksSinceLastForcedTeleport = false;
		initSyncEntityInfoFuncMap();
	}

	EntityTrackerEntry::~EntityTrackerEntry()
	{
		uninitSyncEntityInfoFuncMap();
	}

	bool EntityTrackerEntry::equals(const EntityTrackerEntry& rhs)
	{
		return myEntity->entityId == rhs.myEntity->entityId;
	}

	int EntityTrackerEntry::hashCode()
	{
		return myEntity->entityId;
	}

	void EntityTrackerEntry::informMovementChangeToTrackingPlayers(EntityPlayers& players)
	{
		if (!shouldInformMovement() && !isDelaySync)
			return;

		initializeData(players);

		if (handleItemFrame())
			return;

		sendMovement();

		++ticks;
		sendBeingAttacked();
	}

	void EntityTrackerEntry::informAllAssociatedPlayersOfItemDestruction()
	{
		// Player avatars may only disappear when their owner is really gone.
		// The player entity is also destroyed + re-added by the respawn / world
		// rebuild path while the session stays up, and pushing RemoveEntity
		// there is what made a freshly spawned avatar vanish about a second
		// later. ClientPeer::logout() clears m_logon BEFORE it fires the logout
		// event that removes the entity, so a genuine leave still broadcasts
		// RemoveEntity (peer lookup fails afterwards as well). Items, mobs and
		// every other entity keep the stock behaviour.
		if (auto leavingPlayer = dynamic_cast<EntityPlayerMP*>(myEntity))
		{
			auto peer = ServerNetwork::Instance()->findPlayerByRakssid(leavingPlayer->getRaknetID());
			if (peer && peer->hasLogon())
			{
				return;
			}
		}
		Server::Instance()->getNetwork()->getSender()->sendRemoveEntityToTrackingPlayers(myEntity->entityId);
	}

	void EntityTrackerEntry::removeFromWatchingList(EntityPlayerMP* pPlayer)
	{
		auto it = trackingPlayers.find(pPlayer->entityId);
		if (it != trackingPlayers.end())
		{
			// pPlayer.destroyedItemsNetCache.add(Integer.valueOf(myEntity.entityId));
			trackingPlayers.erase(it->first);
		}
	}

	void EntityTrackerEntry::spawnOrRemoveSelfEntityAtClientOf(EntityPlayerMP* pPlayer, bool rebirth/* = false*/)
	{
		if (pPlayer == myEntity || pPlayer->isLogout())
			return;

		// A tracked PLAYER's lastScaledPos is only refreshed on the tracker
		// frequency tick, while a 10096 fork client's position is adopted in
		// ONE step (ClientPeer::movePlayer snaps the entity to where the client
		// actually loaded in - GameInfo position vs the Lua spawn differ by
		// hundreds of blocks). Measuring the viewer against that stale snapshot
		// made the adoption look like the other player ran away across the map,
		// so the entry fell out of the 512 block gate and pushed
		// S2CPacketRemoveEntity: the avatar showed up at join and vanished a
		// couple of seconds later. Player entries therefore measure against the
		// entity's CURRENT position.
		EntityPlayerMP* trackedPlayer = dynamic_cast<EntityPlayerMP*>(myEntity);
		const float trackedX = trackedPlayer ? myEntity->position.x : lastScaledPos.x / 32.f;
		const float trackedZ = trackedPlayer ? myEntity->position.z : lastScaledPos.z / 32.f;

		float dx = Math::Abs(pPlayer->position.x - trackedX);
		float dz = Math::Abs(pPlayer->position.z - trackedZ);

		// 10096 fork: while the two sides settle on a spawn position the pair
		// can legitimately sit outside the 512 block gate even though both
		// clients are looking right at each other. Removing on that basis is
		// what made fork players flicker out of each other's screens, so a fork
		// session is only ever untracked through the real teardown paths
		// (logout / removePlayerFromTrackers), never by the range heuristic.
		// Stock sessions keep the stock gate.
		const bool forkInvolved = ForkProtocol::isForkSession(pPlayer->getRaknetID())
			|| (trackedPlayer && ForkProtocol::isForkSession(trackedPlayer->getRaknetID()));
		if (pPlayer->m_isCameraLocked)
		{
			float cdx = Math::Abs(pPlayer->m_cameraLockPos.x - lastScaledPos.x / 32.f);
			float cdz = Math::Abs(pPlayer->m_cameraLockPos.z - lastScaledPos.z / 32.f);
			dx = Math::Min(dx, cdx);
			dz = Math::Min(dz, cdz);
		}
		if (myEntity->isClass(ENTITY_CLASS_VEHICLE) ||
			myEntity->isClass(ENTITY_CLASS_FLYING_MOUNT) ||
			myEntity->isClass(ENTITY_CLASS_FLOATING_MOUNT))
		{
			dx = Math::Abs(pPlayer->position.x - myEntity->position.x);
			dz = Math::Abs(pPlayer->position.z - myEntity->position.z);
		}

		bool invisible = false;
		bool canSyncEntity = myEntity->isForceSyncSpawn();
		if (!canSyncEntity)
		{
			canSyncEntity = pPlayer->canSyncEntity();
		}

		if (auto myPlayer = dynamic_cast<EntityPlayerMP*>(myEntity))
		{
			invisible = myPlayer->capabilities.isWatchMode;
		}
		
		const bool outOfRange = dx > m_blocksDistanceThreshold || dz > m_blocksDistanceThreshold;
		const bool sameGroup = myEntity->getIntProperty("TrackerGroupId") == pPlayer->getIntProperty("TrackerGroupId");
		// For a fork pair the range gate is advisory only: spawn anyway, and
		// never untrack on range alone (the else-if below). Otherwise a client
		// that loaded in at its own saved position would neither see nor ever
		// re-see the other player until both happened to move again.
		const bool inRange = !outOfRange || forkInvolved;

		if (inRange && !invisible && sameGroup)
		{
			isDelaySync = !canSyncEntity;
			// Spawn ONLY when the avatar is not on the client yet. Never
			// re-issue SpawnPlayer for an avatar that is already tracked: the
			// client re-creates the entity and re-runs its spawn events /
			// features on top of the old one (scale applied twice -> giant
			// avatar, the owner then dies and the other client crashes).
			// Stock paired the `rebirth` flag with a RemoveEntity sent at
			// destroy time; we keep player avatars alive, so for players
			// `rebirth` must NOT force a second copy. A tracked avatar is kept
			// and its position is corrected by the normal teleport packets.
			const bool shouldSpawn = (trackingPlayers.find(pPlayer->entityId) == trackingPlayers.end())
				|| (rebirth && !trackedPlayer);
			if (shouldSpawn && (isPlayerWatchingThisChunk(pPlayer) || myEntity->forceSpawn) && canSyncEntity)
			{
				trackingPlayers[pPlayer->entityId] = pPlayer;
				//lastHeadMotion = int(Math::Floor(myEntity->getRotationYawHead() * 256.0F / 360.0F));
				lastHeadMotion = myEntity->getRotationYawHead();

				spawnSelfEntityAtClientOf(pPlayer);

				motion = myEntity->motion;
				forceTeleportNow = false;
			}
		}
		else if (!trackedPlayer)
		{
			// Non-player entities (items, mobs, ...) keep the stock untrack
			// behaviour: out of range / hidden / group change -> RemoveEntity.
			if (trackingPlayers.find(pPlayer->entityId) != trackingPlayers.end())
			{
				trackingPlayers.erase(pPlayer->entityId);
				Server::Instance()->getNetwork()->getSender()->sendRemoveEntity(myEntity->entityId, pPlayer);
			}
		}
		// PLAYERS ARE NEVER UNTRACKED HERE. A player avatar must survive every
		// range / watch-mode / group heuristic - the only two places a player
		// avatar may disappear are the real teardown paths:
		//   * the owner's session really ended (onLogout / disconnect), handled
		//     by informAllAssociatedPlayersOfItemDestruction below, and
		//   * the viewer itself logs out (removePlayerFromTrackers, no packet).
		// Sending S2CPacketRemoveEntity here is what made 10096 avatars spawn
		// and vanish again about a second later; the client only ever creates
		// an avatar from S2CPacketSpawnPlayer, so a spurious remove leaves the
		// player invisible until a full re-track happens.
	}

	void EntityTrackerEntry::spawnOrRemoveSelfEntityFor(EntityPlayers& players, bool rebirth/* = false*/)
	{
		for (auto it : players)
		{
			spawnOrRemoveSelfEntityAtClientOf((EntityPlayerMP*)(it.second), rebirth);
		}
	}

	void EntityTrackerEntry::removePlayerFromTracker(EntityPlayerMP* pPlayer)
	{
		auto it = trackingPlayers.find(pPlayer->entityId);
		if (it != trackingPlayers.end())
		{
			trackingPlayers.erase(it);
			// pPlayer.destroyedItemsNetCache.add(Integer.valueOf(myEntity.entityId));
		}
	}

	void EntityTrackerEntry::forceTelport()
	{
		forceTeleportNow = true;
	}

	bool EntityTrackerEntry::isPlayerWatchingThisChunk(EntityPlayerMP* pPlayer)
	{
		return true;
	}

	void EntityTrackerEntry::spawnSelfEntityAtClientOf(EntityPlayerMP* targetPlayer)
	{
		auto sender = Server::Instance()->getNetwork()->getSender();
		// Clear any avatar the viewer may still hold for this entity id before
		// (re)spawning it. A tracker entry can be destroyed and rebuilt while
		// the session stays up (rebirth / world rebuild), and then the entry
		// no longer knows the client already has this avatar - sending a second
		// SpawnPlayer stacks a second model on the first one: features/scale
		// get applied twice (giant avatar) and the duplicated server id pairing
		// crashes the other client ("invalid arguments"). Remove + Spawn go out
		// back-to-back, so the client swaps the model in one step; if it holds
		// nothing the Remove is a harmless no-op.
		if (dynamic_cast<EntityPlayerMP*>(myEntity) != nullptr)
		{
			sender->sendRemoveEntity(myEntity->entityId, targetPlayer);
		}
		sender->sendEntitySpawn(targetPlayer->getRaknetID(), myEntity);

		auto iter = m_syncEntityInfoFuncMap.find(myEntity->getClassID());
		if (iter != m_syncEntityInfoFuncMap.end())
		{
			iter->second(sender, targetPlayer);
		}

		if (!myEntity->m_entityFeatures.empty())
		{
			sender->syncEntityFeatures(targetPlayer->getRaknetID(), myEntity);
		}
	}

	bool EntityTrackerEntry::shouldInformMovement()
	{
		return myEntity->isTrackerSyncMove();
	}

	void EntityTrackerEntry::initializeData(EntityPlayers& players)
	{
		playerEntitiesUpdated = false;

		if (!isDataInitialized || /*true*/myEntity->getDistanceSq(position) > 16.0f || forceTeleportNow || isDelaySync)
		{
			isDelaySync = false;
			isDataInitialized = true;
			playerEntitiesUpdated = true;
			position = myEntity->position;
			spawnOrRemoveSelfEntityFor(players);
		}
	}

	void EntityTrackerEntry::sendBeingAttacked()
	{
		if (myEntity->beenAttacked)
		{
			bool isEntityPlayer = myEntity->isClass(ENTITY_CLASS_PLAYERMP);
			if (!isEntityPlayer) // entityPlayer do not need velocity sync, comment by oujie
			{
				Server::Instance()->getNetwork()->getSender()->sendEntityVelocityToTrackingPlayers(trackingPlayers, myEntity);
				if (myEntity->isClass(ENTITY_CLASS_PLAYERMP))
				{
					Server::Instance()->getNetwork()->getSender()->sendEntityVelocity(((EntityPlayerMP*)myEntity)->getRaknetID(), myEntity);
				}
			}

			myEntity->beenAttacked = false;
		}
	}

	bool EntityTrackerEntry::handleItemFrame()
	{
		if (myEntity->isClass(ENTITY_CLASS_ITEM_FRAME) && ticks % 10 == 0)
		{
			return true;
		}

		return false;
	}

	void EntityTrackerEntry::sendHeadRotation()
	{
		float headYaw = myEntity->getRotationYawHead();

		if (Math::Abs(headYaw - lastHeadMotion) >= 4.0)
		{
			Server::Instance()->getNetwork()->getSender()->sendEntityHeadRotationToTrackingPlayers(trackingPlayers, myEntity->entityId, headYaw);
			lastHeadMotion = headYaw;
		}
	}

	void EntityTrackerEntry::sendMovement()
	{
		if (myEntity->isClass(ENTITY_CLASS_FLYING_MOUNT))
		{
			auto mount = static_cast<EntityFlyingMount*>(myEntity);
			lastScaledPos.x = static_cast<int>(Math::Floor(myEntity->position.x * 32.f));
			lastScaledPos.y = static_cast<int>(Math::Floor(myEntity->position.y * 32.f));
			lastScaledPos.z = static_cast<int>(Math::Floor(myEntity->position.z * 32.f));
			for (const auto& pair : trackingPlayers)
			{
				int playerId = pair.first;
				auto player = static_cast<EntityPlayerMP*>(pair.second);
				if (playerId == mount->getRiderId())
					continue;
				Server::Instance()->getNetwork()->getSender()->sendFlyingMountMovement(
					player->getRaknetID(),
					myEntity->entityId,
					mount->getPosition(),
					mount->getOrientation(),
					mount->getViewOrientation());
			}
			return;
		}
		if (myEntity->isClass(ENTITY_CLASS_FLOATING_MOUNT))
		{
			auto mount = static_cast<EntityFloatingMount*>(myEntity);
			lastScaledPos.x = static_cast<int>(Math::Floor(myEntity->position.x * 32.f));
			lastScaledPos.y = static_cast<int>(Math::Floor(myEntity->position.y * 32.f));
			lastScaledPos.z = static_cast<int>(Math::Floor(myEntity->position.z * 32.f));
			auto rider = mount->getRider();
			for (const auto& pair : trackingPlayers)
			{
				int playerId = pair.first;
				auto player = static_cast<EntityPlayerMP*>(pair.second);
				if (playerId == mount->getRiderId())
					continue;
				Server::Instance()->getNetwork()->getSender()->sendFloatingMountMovement(
					player->getRaknetID(),
					myEntity->entityId,
					mount->getPosition(),
					mount->rotationYaw,
					rider ? rider->rotationYaw : mount->rotationYaw,
					mount->rotationPitch);
			}
			return;
		}
		if (ticks % m_updateFrequency == 0 || myEntity->isAirBorne)
		{
			++ticksSinceLastForcedTeleport;
			Vector3i pos;
			pos.x = int(Math::Floor(myEntity->position.x * 32.f));
			pos.y = int(Math::Floor(myEntity->position.y * 32.f));
			pos.z = int(Math::Floor(myEntity->position.z * 32.f));
			float yaw = myEntity->rotationYaw;
			float pitch = myEntity->rotationPitch;
			Vector3i dpos = pos - lastScaledPos;

			bool moving = Math::Abs(dpos.x) >= 4 || Math::Abs(dpos.y) >= 4 || Math::Abs(dpos.z) >= 4;
			bool rotating = Math::Abs(yaw - lastYaw) >= 4.0 || Math::Abs(pitch - lastPitch) >= 4.0;

			if (myEntity->isClass(ENTITY_CLASS_PLAYER) || 
				myEntity->isClass(ENTITY_CLASS_VEHICLE))
			{
				lastScaledPos = pos;

				// STOCK BEHAVIOUR: a player's / vehicle's own movement is NOT
				// relayed by the tracker. The owning client is authoritative and
				// everyone else only ever receives a forced teleport from the
				// tracker. Player-to-player replication goes through the stock
				// S2CPacketEntityPlayerTeleport broadcast instead
				// (ServerPacketSender::broadCastPlayerMovement), which both stock
				// and 10096 clients handle - see the "S2C other-player movement"
				// block in ForkProtocol.h and the fork broadcast added to
				// ClientPeer::movePlayer().
				if (!forceTeleportNow)
					return;
			}

			sendVelocityChange();

			int maxDistance = 128;
			auto livingBase = dynamic_cast<EntityLivingBase*>(myEntity);
			if (livingBase)
			{
				maxDistance = (int)(128 * 10 * (livingBase->getAIMoveSpeed() + livingBase->getSpeedAddition()));
			}

			if (ticks > 0 && dpos.x >= -maxDistance && dpos.x < maxDistance 
				&& dpos.y >= -maxDistance && dpos.y < maxDistance 
				&& dpos.z >= -maxDistance && dpos.z < maxDistance
				&& ticksSinceLastForcedTeleport <= 400 && !forceTeleportNow)
			{
				if (moving && rotating)
				{
					Server::Instance()->getNetwork()->getSender()->sendEntityMovementToTrackingPlayers(trackingPlayers,
						myEntity->entityId, i16(dpos.x), i16(dpos.y), i16(dpos.z), yaw, pitch);
					/*if (dynamic_cast<EntityPlayer*>(myEntity) && trackingPlayers.size() > 0) {
					LordLogInfo("send entity[%d] movement and rotate to tracking players, dp(%d, %d, %d) moving (%.1f, %.1f, %.1f)",
					myEntity->entityId, dpos.x, dpos.y, dpos.z, myEntity->position.x, myEntity->position.y, myEntity->position.z);
					}*/
				}
				else if (moving)
				{
					Server::Instance()->getNetwork()->getSender()->sendEntityMovementToTrackingPlayers(trackingPlayers,
						myEntity->entityId, i16(dpos.x), i16(dpos.y), i16(dpos.z));
					/*if (dynamic_cast<EntityPlayer*>(myEntity) && trackingPlayers.size() > 0) {
					LordLogInfo("send entity[%d] movement to tracking players, dp(%d, %d, %d) moving (%.1f, %.1f, %.1f)",
					myEntity->entityId, dpos.x, dpos.y, dpos.z, myEntity->position.x, myEntity->position.y, myEntity->position.z);
					}*/
				}
				else if (rotating)
				{
					Server::Instance()->getNetwork()->getSender()->sendEntityMovementToTrackingPlayers(trackingPlayers,
						myEntity->entityId, yaw, pitch);
				}
			}
			else
			{
				Server::Instance()->getNetwork()->getSender()->sendEntityTeleportToTrackingPlayers(trackingPlayers,
					myEntity->entityId, pos.x, pos.y, pos.z, yaw, pitch);

				EntityPlayerMP* self = dynamic_cast<EntityPlayerMP*>(myEntity);
				if (forceTeleportNow && self) {
					// The 10096 fork client picks its own spawn point from GameInfo
					// while the server places the entity at the Lua respawnPos, so
					// bouncing the server's (stale) position back to the player's own
					// client yanked it across the map on join - the "fling on spawn".
					// A fork client is authoritative for its own position; it never
					// needs a correction aimed at itself, only at the other viewers.
					if (!ForkProtocol::isForkSession(self->getRaknetID()))
					{
						Server::Instance()->getNetwork()->getSender()->sendEntityTeleport(
							self->getRaknetID(), myEntity->entityId, pos.x, pos.y, pos.z, yaw, pitch);
					}

					forceTeleportNow = false;
				}
				ticksSinceLastForcedTeleport = 0;
				/*if (dynamic_cast<EntityPlayer*>(myEntity)) {
				LordLogInfo("send entity[%d] teleport to tracking players and self, dp(%d, %d, %d) moving (%.1f, %.1f, %.1f)",
				myEntity->entityId, dpos.x, dpos.y, dpos.z, myEntity->position.x, myEntity->position.y, myEntity->position.z);
				}*/
			}

			if (moving)
			{
				/*if (dynamic_cast<EntityPlayer*>(myEntity)) {
				LordLogDebug("update entity[%d] lastScaledPos, ticks=%u, original=(%d,%d,%d), now=(%d,%d,%d), dpos=(%d,%d,%d)/32 = (%f,%f,%f)",
				myEntity->entityId, ticks, int(lastScaledPos.x/32), int(lastScaledPos.y/32), int(lastScaledPos.z/32),
				int(pos.x/32), int(pos.y/32), int(pos.z/32), dpos.x, dpos.y, dpos.z, dpos.x/32.0, dpos.y/32.0, dpos.z/32.0);
				}*/
				lastScaledPos = pos;
			}

			if (rotating)
			{
				lastYaw = yaw;
				lastPitch = pitch;
			}

			sendHeadRotation();
			myEntity->isAirBorne = false;
		}
	}

	void EntityTrackerEntry::sendVelocityChange()
	{
		if (sendVelocityUpdates)
		{
			Vector3 dm = myEntity->motion - motion;
			float var19 = 0.02f;
			float dmLenSqr = dm.lenSqr();

			if (dmLenSqr > var19 * var19 || dmLenSqr > 0.0f && myEntity->motion == Vector3::ZERO)
			{
				motion = myEntity->motion;
				Server::Instance()->getNetwork()->getSender()->sendEntityVelocityToTrackingPlayers(trackingPlayers, myEntity->entityId, motion.x, motion.y, motion.z);
			}
		}
	}

	void EntityTrackerEntry::initSyncEntityInfoFuncMap()
	{
		m_syncEntityInfoFuncMap = 
		{
			{ (int)ENTITY_CLASS_PLAYERMP, std::bind(&EntityTrackerEntry::syncEntityPlayerInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_MERCHANT, std::bind(&EntityTrackerEntry::syncEntityMerchantInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_VEHICLE, std::bind(&EntityTrackerEntry::syncEntityVehicileInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_AIRCRAFT, std::bind(&EntityTrackerEntry::syncEntityAircraftInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_RANK_NPC, std::bind(&EntityTrackerEntry::syncEntityRankNpcInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_ACTOR_NPC, std::bind(&EntityTrackerEntry::syncEntityActorNpcInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_SESSION_NPC, std::bind(&EntityTrackerEntry::syncEntitySessionNpcInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_CREATUREAI, std::bind(&EntityTrackerEntry::syncEntityCreatureInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_WALKING_DEAD_AI, std::bind(&EntityTrackerEntry::syncEntityCreatureInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_BLOCKMAN, std::bind(&EntityTrackerEntry::syncEntityBlockmanInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_BLOCKMAN_EMPTY, std::bind(&EntityTrackerEntry::syncEntityBlockmanEmptyInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_ACTOR_CANNON, std::bind(&EntityTrackerEntry::syncEntityActorCannonInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_BUILD_NPC, std::bind(&EntityTrackerEntry::syncEntityBuildNpcInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_LAND_NPC, std::bind(&EntityTrackerEntry::syncEntityLandNpcInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_BULLETIN, std::bind(&EntityTrackerEntry::syncEntityBulletinInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_BIRDAI, std::bind(&EntityTrackerEntry::syncEntityBirdInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_DECORATION, std::bind(&EntityTrackerEntry::syncEntityDecorationInfo, this, std::placeholders::_1, std::placeholders::_2) },
			{ (int)ENTITY_CLASS_PLAYER_AI, std::bind(&EntityTrackerEntry::syncEntityPlayerInfo, this, std::placeholders::_1, std::placeholders::_2) },
		};
	}

	void EntityTrackerEntry::uninitSyncEntityInfoFuncMap()
	{
		m_syncEntityInfoFuncMap.clear();
	}

	void EntityTrackerEntry::syncEntityPlayerInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP* targetPlayer)
	{
		EntityPlayerMP* selfPlayer = static_cast<EntityPlayerMP*>(myEntity);
		
		sender->sendSetWatchMode(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->capabilities.isWatchMode);
		std::shared_ptr<ClientPeer> selfClientPeer = ServerNetwork::Instance()->findPlayerByRakssid(selfPlayer->getRaknetID());

		if (selfClientPeer) {
			if (selfPlayer->m_isClothesChanged)
			{
				sender->sendUserAttrFromEntity(targetPlayer->getRaknetID(), selfPlayer);
			}
			else
			{
				UserAttrInfo selfAttrInfo;
				if (Server::Instance()->getEnableRoom())
				{
					bool succ = Server::Instance()->getRoomManager()->getUserAttrInfo(selfClientPeer->getPlatformUserId(), selfAttrInfo);
					if (succ) {
						sender->sendUserAttr(targetPlayer->getRaknetID(), selfPlayer->entityId, selfAttrInfo, selfPlayer);
					}
					else {
						LordLogError("spawnSelfEntityAtClient but can not get user attr, self platform id " U64FMT
							", target player name %s, be sent player name %s",
							selfClientPeer->getPlatformUserId(), targetPlayer->getShowName().c_str(), selfPlayer->getShowName().c_str());
					}
				}
			}
		}
		else {
			LordLogError("spawnSelfEntityAtClient but can not find self client peer,self session id " U64FMT
				", target player name %s, be sent player name %s",
				selfPlayer->getRaknetID(), targetPlayer->getShowName().c_str(), selfPlayer->getShowName().c_str());
		}

		sender->sendChangePlayerMaxHealth(targetPlayer->getRaknetID(), selfPlayer->hashCode(), selfPlayer->getMaxHealth(), false);
		sender->sendEntityAttribute(targetPlayer, selfPlayer);
		sender->sendChangeItemInHand(targetPlayer, selfPlayer->entityId, selfPlayer->inventory->getCurrentItem());
		sender->sendSetFlying(targetPlayer->getRaknetID(), selfPlayer);
		sender->sendSetPlayerGlide(targetPlayer->getRaknetID(), selfPlayer);
		sender->sendSetPlayerElevator(targetPlayer->getRaknetID(), selfPlayer);

		int speedLevel = (int)(selfPlayer->getSpeedAddition() * 1000 * 5);
		sender->sendEntitySpeedAdditionLevel(targetPlayer->getRaknetID(), selfPlayer->entityId, speedLevel);

		if (selfPlayer->getTeamId() != 0)
		{
			sender->sendChangePlayerTeam(targetPlayer->getRaknetID(), selfPlayer->getPlatformUserId(), selfPlayer->getTeamId());
		}
		if (selfPlayer->m_isPeopleActor == false)
		{
			sender->sendPlayerChangeActor(targetPlayer->getRaknetID(), selfPlayer);
		}
		auto armorInventory = selfPlayer->inventory->getArmorInventory();
		vector<ItemStackPtr>::type armors;
		for (int i = 0; i < armorInventory->getSizeInventory(); ++i)
		{
			if (armorInventory->getStackInSlot(i))
			{
				armors.push_back(armorInventory->getStackInSlot(i));
			}
		}
		sender->sendEquipArmors(targetPlayer, selfPlayer->entityId, armors);

		auto activePotionMap = selfPlayer->getActivePotionEffects();
		for (auto it : activePotionMap) {
			sender->sendAddEntityEffect(targetPlayer, selfPlayer->entityId, it.second);
		}

		if (selfPlayer->isSneaking()) {
			sender->sendPlayerAction(targetPlayer->getRaknetID(), selfPlayer->entityId, NETWORK_DEFINE::PacketPlayerActionType::START_SNEAK);
		}

		if (selfPlayer->isOnVehicle() && selfPlayer->getVehicle() != NULL)
		{
			sender->syncPlayerTakeOnVehicle(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->isDriver(), selfPlayer->getVehicle()->entityId);
		}

		if (selfPlayer->isOnAircraft() && selfPlayer->getAircraft() != NULL)
		{
			sender->syncPlayerTakeAircraft(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->getAircraft()->entityId);
		}

		if (selfPlayer->isOnFlyingMount())
		{
			sender->sendGetOnFlyingMount(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->getFlyingMountId());
		}

		if (selfPlayer->isOnFloatingMount())
		{
			sender->sendGetOnFloatingMount(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->getFloatingMountId());
		}

		if (selfPlayer->m_isCameraLocked)
		{
			sender->SyncCameraLockStatus(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->m_isCameraLocked);
		}

		sender->syncEntityPlayerAnimate(targetPlayer->getRaknetID(), NETWORK_DEFINE::PacketAnimateType::ANIMATE_TYPE_BASE_ACTION,
			selfPlayer->entityId, selfPlayer->getBaseAction(), selfPlayer->m_holdItemId);
		sender->syncEntityPlayerAnimate(targetPlayer->getRaknetID(), NETWORK_DEFINE::PacketAnimateType::ANIMATE_TYPE_UPPER_ACTION,
			selfPlayer->entityId, selfPlayer->getUpperAction(), selfPlayer->m_holdItemId);
		sender->syncEntityPlayerMovementInput(targetPlayer->getRaknetID(), selfPlayer->entityId);
		sender->sendEntityPlayerOccupation(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->getOccupation());
		sender->syncPlayerBagInfo(targetPlayer->getRaknetID(), selfPlayer);
		sender->syncTakeDecoration(targetPlayer->getRaknetID(), selfPlayer->hashCode(), selfPlayer->getDecorationEntity() ? selfPlayer->getDecorationEntity()->hashCode() : 0);

		if (selfPlayer->isFrozen())
			sender->syncEntityFrozenTime(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->getFrozenTime());
		if (selfPlayer->isHurted())
			sender->syncEntityHurtTime(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->getHurtTime());
		if (selfPlayer->isColorful())
			sender->syncEntityColorfulTime(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->getColorfulTime());
		if (selfPlayer->isDisableMove())
			sender->syncEntityDisableMoveTime(targetPlayer->getRaknetID(), selfPlayer->entityId, selfPlayer->getDisableMoveTime());

		SCRIPT_EVENT::PlayerReviewPlayerEvent::invoke(selfPlayer->getRaknetID(), targetPlayer->getRaknetID());
	}

	void EntityTrackerEntry::syncEntityMerchantInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP* targetPlayer)
	{
		auto entityMerchant = dynamic_cast<EntityMerchant*>(myEntity);
		CommodityMapping mapping = CommodityManager::Instance()->getMapping(entityMerchant->entityId, targetPlayer->getRaknetID());
		sender->sendUpdateMerchant(mapping.rakssId, mapping.entityId, mapping.index);
	}

	void EntityTrackerEntry::syncEntityVehicileInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entityVehicle = dynamic_cast<EntityVehicle*>(myEntity);
		sender->sendSyncVehicleState(targetPlayer->getRaknetID(), entityVehicle->entityId);
	}

	void EntityTrackerEntry::syncEntityAircraftInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entityAircraft = dynamic_cast<EntityAircraft*>(myEntity);
		sender->syncAircraftState(targetPlayer->getRaknetID(), entityAircraft->entityId);
	}

	void EntityTrackerEntry::syncEntityRankNpcInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entityRankNpc = dynamic_cast<EntityRankNpc*>(myEntity);
		sender->sendUpdateRankNpc(targetPlayer->getRaknetID(), entityRankNpc->entityId);
	}

	void EntityTrackerEntry::syncEntityActorNpcInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entityActorNpc = dynamic_cast<EntityActorNpc*>(myEntity);
		sender->sendNpcActorInfo(targetPlayer->getRaknetID(), entityActorNpc);
		SCRIPT_EVENT::PlayerReviewActorNpcEvent::invoke(targetPlayer->getRaknetID(), entityActorNpc->hashCode());
	}
	
	void EntityTrackerEntry::syncEntitySessionNpcInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entitySessionNpc = dynamic_cast<EntitySessionNpc*>(myEntity);
		sender->syncSessionNpc(targetPlayer->getRaknetID(), entitySessionNpc);

		IntProxy time;
		time.value = 0;
		if (!SCRIPT_EVENT::OtherSessionNpcInfoEvent::invoke(targetPlayer->getRaknetID(), &time))
		{
			sender->sendSessionNpcHeadInfoTimeLang(targetPlayer->getRaknetID(), entitySessionNpc->hashCode(), entitySessionNpc->getNameLang(), 0, time.value);
		}
	}
	

	void EntityTrackerEntry::syncEntityCreatureInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP* targetPlayer)
	{
		auto entityCreature = dynamic_cast<EntityCreature*>(myEntity);
		if (entityCreature)
		{
			sender->sendUpdateEntityCreature(targetPlayer->getRaknetID(), entityCreature);
			sender->sendCreatureEntityAction(targetPlayer->getRaknetID(), entityCreature->entityId, (int)entityCreature->getCreatureAction(), (int)entityCreature->getCreatureAction(), (int)entityCreature->getPreCreatureAction());
			sender->syncEntityHealth(targetPlayer->getRaknetID(), entityCreature->entityId, entityCreature->getHealth(), entityCreature->getMaxHealth());
			int speedLevel = (int)(entityCreature->getSpeedAddition() * 1000 * 5);
			sender->sendEntitySpeedAdditionLevel(targetPlayer->getRaknetID(), entityCreature->entityId, speedLevel);
		}
	}

	void EntityTrackerEntry::syncEntityBlockmanInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entity = dynamic_cast<EntityBlockman*>(myEntity);
		sender->syncEntityBlockman(targetPlayer->getRaknetID(), entity);
	}

	void EntityTrackerEntry::syncEntityBlockmanEmptyInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		syncEntityBlockmanInfo(sender, targetPlayer);
		auto entity = dynamic_cast<EntityBlockmanEmpty*>(myEntity);
		sender->syncBlockmanMoveAttr(targetPlayer->getRaknetID(), entity);
		sender->syncEntityFrozenTime(targetPlayer->getRaknetID(), entity->entityId, entity->getFrozenTime());
	}

	void EntityTrackerEntry::syncEntityActorCannonInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entityActorCannon = dynamic_cast<EntityActorCannon*>(myEntity);
		sender->sendCannonActorInfo(targetPlayer->getRaknetID(), entityActorCannon);
	}
	
	void EntityTrackerEntry::syncEntityBuildNpcInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entity = dynamic_cast<EntityBuildNpc*>(myEntity);
		sender->syncEntityBuildNpc(targetPlayer->getRaknetID(), entity);
	}

	void EntityTrackerEntry::syncEntityLandNpcInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entity = dynamic_cast<EntityLandNpc*>(myEntity);
		sender->syncEntityLandNpc(targetPlayer->getRaknetID(), entity);
	}

	void EntityTrackerEntry::syncEntityBulletinInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entity = dynamic_cast<EntityBulletin*>(myEntity);
		sender->syncEntityBulletin(targetPlayer->getRaknetID(), entity);
	}

	void EntityTrackerEntry::syncEntityBirdInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entity = dynamic_cast<EntityBirdAI*>(myEntity);
		sender->syncEntityBird(targetPlayer->getRaknetID(), entity);
		sender->sendEntityAction(targetPlayer->getRaknetID(), entity->entityId, (int)entity->getClassID(), (int)entity->getBirdAction(), (int)entity->getBirdAction(), (int)entity->getPreBirdAction());
		int speedLevel = (int)(entity->getSpeedAddition() * 1000 * 5);
		sender->sendEntitySpeedAdditionLevel(targetPlayer->getRaknetID(), entity->entityId, speedLevel);
	}

	void EntityTrackerEntry::syncEntityDecorationInfo(const std::shared_ptr<ServerPacketSender>& sender, EntityPlayerMP * targetPlayer)
	{
		auto entity = dynamic_cast<EntityDecoration*>(myEntity);
		sender->syncEntityDecoration(targetPlayer->getRaknetID(), entity);
	}
}
