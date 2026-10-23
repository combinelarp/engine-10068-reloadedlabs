#include "ClientNetworkRecver.h"
#include "Network/S2CPacketDispatch.h"

void registerS2CChatPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CGamePacketHandles(S2CPacketDispatch& dispatch);
void registerS2CRanchPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CBirdSimulatorPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CBlockCityPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CEntityPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CPlayerActionPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CCommonDataPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CBlockFortPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CInitPacketHandles(S2CPacketDispatch& dispatch);
void registerS2CStatusPacketHandles(S2CPacketDispatch& dispatch);
void initClientCommonDataHelper();

void ClientNetworkRecver::initInner()
{
	registerS2CChatPacketHandles(*m_packetDispatch);
	registerS2CGamePacketHandles(*m_packetDispatch);
	registerS2CRanchPacketHandles(*m_packetDispatch);
	registerS2CBirdSimulatorPacketHandles(*m_packetDispatch);
	registerS2CBlockCityPacketHandles(*m_packetDispatch);
	registerS2CEntityPacketHandles(*m_packetDispatch);
	registerS2CPlayerActionPacketHandles(*m_packetDispatch);
	registerS2CCommonDataPacketHandles(*m_packetDispatch);
	registerS2CBlockFortPacketHandles(*m_packetDispatch);
	registerS2CInitPacketHandles(*m_packetDispatch);
	registerS2CStatusPacketHandles(*m_packetDispatch);
	initClientCommonDataHelper();
}
