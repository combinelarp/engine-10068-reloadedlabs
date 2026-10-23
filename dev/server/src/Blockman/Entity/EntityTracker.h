/********************************************************************
filename: 	EntityTracker.h
file path:	h:\sandboxol\client\blockmango-client\dev\server\src\Entity
version:	1
author:		zhouyou
company:    sandboxol
date:		2017/07/11
*********************************************************************/
#pragma once

#ifndef __ENTITY_TRACKER_H__
#define __ENTITY_TRACKER_H__

#include "EntityTrackerEntry.h"

namespace BLOCKMAN
{
class World;
class Entity;
class EntityPlayerMP;

typedef set<EntityTrackerEntry*>::type EntityTrackerSet;
typedef map<int, EntityTrackerEntry*>::type IDEntityTrackerMap;

class EntityTracker : public Singleton<EntityTracker>, public ObjectAlloc
{
protected:
	World* m_world;

	/** List of tracked entities, used for iteration operations on tracked entities. */
	EntityTrackerSet m_entitySet;
	IDEntityTrackerMap m_idEntityMap;
public:
	EntityTracker(World* pWorld);
	virtual ~EntityTracker();

	/** if entity is a player sends all tracked events to the player, otherwise, adds with a visibility and update arate based on the class type */
	void addEntityToTracker(Entity* toAddEntity);

	void removeEntityFromAllTrackingPlayers(Entity* pEntity);

	void updateTrackedEntities();
	
	void removePlayerFromTrackers(EntityPlayerMP* pPlayer);
	
	void sendLeashedEntitiesInChunk(EntityPlayerMP* pPlayer, const ChunkPtr& pChunk);

	const EntityPlayers getTrackingPlayersOf(int entityId) const;
	
	bool forceTeleport(int entityId);

	// Re-run the spawn decision for every tracked entity against every player.
	//
	// EntityTrackerEntry::spawnOrRemoveSelfEntityAtClientOf only adds a player
	// to another entry's trackingPlayers when the OBSERVED player passes
	// canSyncEntity() - i.e. has already sent C2SPacketClientReady. A player who
	// logs in while others are already present therefore never gets added to
	// those entries' tracking sets, and because nothing re-checks the condition
	// afterwards they stay invisible to everyone for the rest of the session
	// (the "other player disappears" bug). Calling this the moment a client
	// becomes ready makes every entry re-evaluate, so the new client both sees
	// everyone and is seen by them.
	void respawnEntitiesForReadyPlayer();

private:
    void addEntityToTracker_inner(Entity* toAddEntity, int viewDis, int frequency, bool sendVelocity = false);
};

}

#endif