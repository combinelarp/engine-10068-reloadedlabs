#include "S2CGamePacketHandles.h"
#include "Network/S2CPacketDispatch.h"
#include "Util/ClientEvents.h"
#include "Setting/LogicSetting.h"

using namespace BLOCKMAN;

void S2CGamePacketHandles::handlePacket(std::shared_ptr<S2CPacketCarDirection>& packet)
{
	UpdateCarDirectionEvent::emit(packet->type, packet->direction);
}

void S2CGamePacketHandles::handlePacket(std::shared_ptr<S2CPacketCarProgress>& packet)
{
	UpdateCarProgressEvent::emit(packet->type, packet->progress);
}

void S2CGamePacketHandles::handlePacket(std::shared_ptr<S2CPacketEnableAutoShoot>& packet)
{
	LogicSetting::Instance()->setAutoShootEnable(packet->enable);
}

void S2CGamePacketHandles::handlePacket(std::shared_ptr<S2CPacketSyncGameWeather>& packet)
{
	LogicSetting::Instance()->setGameWeather(packet->weatherType);
}

void registerS2CGamePacketHandles(S2CPacketDispatch& dispatch)
{
	dispatch.registerClass<S2CGamePacketHandles>();
}
