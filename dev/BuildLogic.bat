@echo off
set "PROJ=%~dp0logic\Build\Src\Logic.vcxproj"

echo Building Logic Debug Win32 ...
"%MSBUILD%" "%PROJ%" /p:Configuration=Debug /p:Platform=Win32 /m /nologo
if errorlevel 1 (
    echo *** LOGIC BUILD FAILED ***
    pause
    exit /b 1
)
echo *** LOGIC BUILD OK ***
pause
