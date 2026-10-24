/********************************************************************
filename: 	S2CPacketDispatch
file path:	H:\sandboxol\client\blockmango-client\dev\client\Src\Network\S2CPacketDispatch.h

version:	1
author:		qutianxiang
company:    sandboxol
date:		2017/07/26
*********************************************************************/
#ifndef __S2CPACKETDISPATCH_H__
#define __S2CPACKETDISPATCH_H__

#include "Network/PacketHandlerRegistry.h"

template<typename T, S2CPacketType type>
struct HasS2CPacketHandle
{
	typedef void(*handleFucPtr)(std::shared_ptr< S2CPacket<type> >&);

	template<typename U, handleFucPtr ptr> struct HELPS;
	template<typename U> static char Test(HELPS<U, &U::handlePacket>*);
	template<typename U> static int Test(...);
	const static bool value = sizeof(Test<T>(0)) == sizeof(char);
};

class S2CPacketDispatch : public PacketHandlerRegistry<S2CPacketType, S2CPacket>, public ObjectAlloc
{
public:
	template<typename Packet, typename T>
	using MethodCallback = void (T::*)(std::shared_ptr<Packet>);

public:
	S2CPacketDispatch() {}
	~S2CPacketDispatch() {}

	template<typename T, S2CPacketType type>
	void registerHandle(MethodCallback<S2CPacket<type>, T>methodCallback,  T* thisPtr);

	template<typename T>
	void registerClass() {
		registerClassHelp<T, (int)S2CPacketType::ProtocolBegin, (int)S2CPacketType::ProtocolEnd>();
	}

private:

	template<typename T, int Begin, int End>
	typename std::enable_if<(Begin < End), void>::type registerClassHelp() {
		const int Mid = Begin + (End - Begin) / 2;
		registerClassHelp<T, Begin, Mid>();
		registerClassHelp<T, Mid + 1, End>();
	}

	template<typename T, int Begin, int End>
	typename std::enable_if<(Begin == End), void>::type registerClassHelp() {
		registerClassMember<T, (S2CPacketType)Begin, HasS2CPacketHandle<T, (S2CPacketType)Begin>::value>();
	}

	template<typename T, S2CPacketType type, bool has>
	typename std::enable_if<has, void>::type registerClassMember()
	{
		typedef void(*handleFuncPtr)(std::shared_ptr < S2CPacket<type> > &);
		registerHandler<type>((handleFuncPtr)&T::handlePacket);
	}

	template<typename T, S2CPacketType type, bool has>
	typename std::enable_if<!has, void>::type registerClassMember() {};

};

#endif // !__ClientNetPlayer_H__

