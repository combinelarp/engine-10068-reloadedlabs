
@echo off
setlocal EnableExtensions
pushd "%~dp0" || exit /b 1

set "PROJECT_DIR=%CD%/Blockmango"
set "BUILD_TYP=0"
set "APP_APP_ABI=armeabi-v7a"

:parse_args
if "%~1"=="" goto args_done
if "%~1"=="-t" goto parse_type
if "%~1"=="-i" goto parse_abi
echo Error: Unknown argument "%~1"
goto usage_error

:parse_type
if "%~2"=="0" goto type_release
if "%~2"=="1" goto type_debug
echo Error: -t must be 0 (Release) or 1 (Debug).
goto usage_error

:type_release
set "BUILD_TYP=0"
shift
shift
goto parse_args

:type_debug
set "BUILD_TYP=1"
shift
shift
goto parse_args

:parse_abi
if "%~2"=="" goto invalid_abi
set "VALID_ABI="
for %%A in (arm64-v8a armeabi armeabi-v7a mips mips64 x86 x86_64 all) do if /i "%~2"=="%%A" set "VALID_ABI=1"
if not defined VALID_ABI goto invalid_abi
set "APP_APP_ABI=%~2"
shift
shift
goto parse_args

:invalid_abi
echo Error: Invalid or missing ABI.
goto usage_error

:usage_error
echo Usage: build.bat [-t 0^|1] [-i ABI]
echo ABI: all arm64-v8a armeabi armeabi-v7a mips mips64 x86 x86_64
popd
exit /b 1

:args_done
set "ROOT_DIR=%PROJECT_DIR%\..\..\..\..\.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"

set "ENGINE_DIR=%ROOT_DIR%\engine-core\dev\engine"
set "LOGIC_DIR=%ROOT_DIR%\dev\logic"
set "CLIENT_DIR=%ROOT_DIR%\dev\client"

echo.
echo Build type: %BUILD_TYP%
echo ABI: %APP_APP_ABI%
echo Project: %PROJECT_DIR%
echo Root: %ROOT_DIR%
echo.

if not exist "%PROJECT_DIR%\app\." (
    echo Error: Missing Android app directory: "%PROJECT_DIR%\app"
    goto build_failed
)

if not exist "%ENGINE_DIR%\NDKBuild\." (
    echo Error: Engine NDKBuild directory not found: "%ENGINE_DIR%\NDKBuild"
    goto build_failed
)

if not exist "%ENGINE_DIR%\NDKBuild\DepBuild\." (
    echo Error: Dependency build directory not found: "%ENGINE_DIR%\NDKBuild\DepBuild"
    goto build_failed
)

if not exist "%ENGINE_DIR%\ApkBuild\." (
    echo Error: Engine APK build directory not found: "%ENGINE_DIR%\ApkBuild"
    goto build_failed
)

if not exist "%LOGIC_DIR%\ApkBuild\." (
    echo Error: Logic APK build directory not found: "%LOGIC_DIR%\ApkBuild"
    goto build_failed
)

if not exist "%CLIENT_DIR%\ApkBuild\." (
    echo Error: Client APK build directory not found: "%CLIENT_DIR%\ApkBuild"
    goto build_failed
)

where ndk-build >nul 2>&1
if errorlevel 1 (
    echo Error: ndk-build not found in PATH.
    goto build_failed
)

call :build "%ENGINE_DIR%\NDKBuild" "LordCore LordGLES2Render zlib"
if errorlevel 1 goto build_failed

call :build "%ENGINE_DIR%\NDKBuild\DepBuild" "FreeType FreeImage"
if errorlevel 1 goto build_failed

call :build "%ENGINE_DIR%\ApkBuild" "LordGLES2Render libLordCore"
if errorlevel 1 goto build_failed

call :build "%LOGIC_DIR%\ApkBuild" "libLogic"
if errorlevel 1 goto build_failed

call :build "%CLIENT_DIR%\ApkBuild" "libGameClient"
if errorlevel 1 goto build_failed

call :build "%PROJECT_DIR%\app" "libMineCraft"
if errorlevel 1 goto build_failed

echo.
echo ========================================
echo BUILD COMPLETED SUCCESSFULLY
echo ========================================
popd
exit /b 0

:build
if not exist "%~1\." (
    echo Error: Build directory not found: "%~1"
    exit /b 1
)

echo.
echo ========================================
echo Building %~2
echo ========================================

pushd "%~1"
if errorlevel 1 (
    echo Error: Cannot enter "%~1"
    exit /b 1
)

call ndk-build NDK_DEBUG=%BUILD_TYP% APP_ABI=%APP_APP_ABI% -j6
set "BUILD_RESULT=%ERRORLEVEL%"
popd

if not "%BUILD_RESULT%"=="0" (
    echo Error: Failed building %~2. Exit code: %BUILD_RESULT%
    exit /b 1
)

exit /b 0

:build_failed
echo.
echo ========================================
echo BUILD FAILED
echo ========================================
popd
exit /b 1
