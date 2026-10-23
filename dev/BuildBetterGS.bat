@echo off
setlocal
set "MSBUILD=C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe"
set "LOGIC=%~dp0logic\Build\Src\Logic.vcxproj"
set "PROJ=%~dp0server\Build\src\GameServer.vcxproj"

echo Building Logic Debug Win32 ...
"%MSBUILD%" "%LOGIC%" /p:Configuration=Debug /p:Platform=Win32 /m /nologo
if errorlevel 1 (
    echo *** LOGIC BUILD FAILED ***
    pause
    exit /b 1
)

echo Building GameServer Debug Win32 ...
"%MSBUILD%" "%PROJ%" /p:Configuration=Debug /p:Platform=Win32 /m /nologo
if errorlevel 1 (
    echo *** GAMESERVER BUILD FAILED ***
    pause
    exit /b 1
)
echo *** GAMESERVER BUILD OK ***
pause
