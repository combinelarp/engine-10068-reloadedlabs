This is the source code of Blockman Go, It is not completely owned by the owner of the repository.,
All rights will remain on the Blockman Go Studio Company on asserting this repository.

NOTE: This is an text is an archive and does not intend to go against on the Copyright 2020 ©, It is 
intended to be only an archive of the Sources. More over, majority of the sources are no
longer in current use of the stakeholders therefore makes it deprecated.

All Developers must only use it for Educational Purposes, If you intend to go against
the copyright of the Blockman Go application. Further legal actions will be made.
Therefore, you cannot declare a credibility with your own instance. It must only
be used for experimental and testing purposes.

Credits: Sandboxol, Zhuhai City (Blockman Go Studio), (https://sandboxol.cn/)

How to build? for Windows
-------------------------
Prereqs: Visual Studio 2015/2017/2019 (C++ workload), CMake, Git.

1. Generate all CMake projects (updates/clones engine-core, then runs CMake as Win32):
   cd D:\Download\SandboxOL\engine-10068\dev
   cmakeall.cmd
   (use cmakeall_with_clean.cmd for a clean rebuild)

2. Build engine-core (LordCore) FIRST: open and build
   engine-core\dev\engine\Build\Lord.sln
   engine-core\dev\clothes\Build\Clothes.sln
   then dev\logic\Build\Logic.sln

3. Open and build the shells in Visual Studio:
   Client:      dev\client\Shells\Win32\WinShell.sln
   Game server: dev\server\WinServer.sln
   (WinShell.sln also builds Core/GLES2Render/Logic via project deps)

4. Build Debug/Release. Outputs:
   engine-core\dev\engine\Bin\<Cfg>
   dev\logic\Bin\<Cfg>
   dev\client\Bin\<Cfg>
   dev\server\Bin\<Cfg>

Note: cmakeall.cmd generates engine-core\{clothes,engine} and dev\{client,logic,server}.
The Win32 shell (WinShell.sln) is a standalone solution opened manually.

How to build? For android
-------------------------
Prereqs: JDK 8, Android Studio + SDK, and NDK r16b or older
(gnustl_static/gnustl_shared are used; removed in NDK r18+).

Set env once:
   set NDK_ROOT=C:\android-ndk-r16b
   set PATH=%NDK_ROOT%;%PATH%

Build native libs in this order (APP_ABI=armeabi-v7a, NDK_DEBUG=0 release / 1 debug):
   cd engine-core\dev\libraries\ApkBuild        && ndk-build NDK_DEBUG=0 APP_ABI=armeabi-v7a -j4
   cd engine-core\dev\engine\NDKBuild           && ndk-build NDK_DEBUG=0 APP_ABI=armeabi-v7a -j4
   cd engine-core\dev\engine\NDKBuild\DepBuild  && ndk-build NDK_DEBUG=0 APP_ABI=armeabi-v7a -j4
   cd engine-core\dev\engine\ApkBuild           && ndk-build NDK_DEBUG=0 APP_ABI=armeabi-v7a -j4
   cd dev\logic\ApkBuild                        && ndk-build NDK_DEBUG=0 APP_ABI=armeabi-v7a -j4
   cd dev\client\ApkBuild                       && ndk-build NDK_DEBUG=0 APP_ABI=armeabi-v7a -j4
   cd dev\client\Shells\Android\Blockmango\app  && ndk-build NDK_DEBUG=0 APP_ABI=armeabi-v7a -j4

Shortcut: dev\client\Shells\Android\buildAndroid.bat runs the whole sequence
(-t 0/1 = release/debug, -i <abi>).

Build the APK:
   cd dev\client\Shells\Android\Blockmango
   gradlew.bat assembleRelease
   (or assembleDebug / open the folder in Android Studio)

Note: libcurl.a must exist under dev\client\curl\Android\Lib\<optim>\<abi>\.

How to build? For Ios
---------------------
Must be on macOS with Xcode + iOS SDK, CMake.

Generate Xcode projects (build dir IOSBuild):
   cd engine-core\dev\engine  && mkdir IOSBuild && cd IOSBuild && cmake -G Xcode -DLORD_BUILD_PLATFORM_IOS=ON -DLORD_STATIC=ON .. && open Lord.xcodeproj
   cd engine-core\dev\clothes && mkdir IOSBuild && cd IOSBuild && cmake -G Xcode -DLORD_BUILD_PLATFORM_IOS=ON -DLORD_STATIC=ON .. && open Clothes.xcodeproj
   cd dev\logic               && mkdir IOSBuild && cd IOSBuild && cmake -G Xcode -DLORD_BUILD_PLATFORM_IOS=ON -DLORD_STATIC=ON .. && open Logic.xcodeproj
   cd dev\client              && mkdir IOSBuild && cd IOSBuild && cmake -G Xcode -DLORD_BUILD_PLATFORM_IOS=ON -DLORD_STATIC=ON .. && open Client.xcodeproj

Build each target as Release; outputs go to dev\client\Shells\IOS\GameClothLibs\Release.

Then open the app shell in Xcode and archive:
   dev\client\Shells\IOS\BlockWorld\BlockWorld.xcodeproj
   (also BlockModsGameKit, KingBeatKnight)
Select a real iOS device, signing is "iPhone Developer", then Product > Archive.

Note: targets armv7/armv7s/arm64, deployment target 9.0, bitcode off, libc++/c++0x
are set in the CMake files; do not override them.

Branch rule: engine-core must match the client branch as core_old_<branch>
(see dev\deploy\pullcore.sh). A mismatch causes link errors.
