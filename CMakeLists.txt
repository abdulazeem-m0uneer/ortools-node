cmake_minimum_required(VERSION 3.18)
# CMake >= 3.27: find_package(ortools) also honours the ORTOOLS_ROOT variable.
if(POLICY CMP0144)
  cmake_policy(SET CMP0144 NEW)
endif()
project(ortools_node CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ---------------------------------------------------------------------------
# Locate OR-Tools.
# Point ORTOOLS_ROOT at an extracted OR-Tools C++ release (the directory that
# contains include/, lib/ and lib/cmake/ortools/).  Download releases from
# https://github.com/google/or-tools/releases  (e.g. or-tools_x86_64_Ubuntu-22.04_cpp_v9.x.tar.gz)
# ---------------------------------------------------------------------------
if(DEFINED ENV{ORTOOLS_ROOT})
  list(APPEND CMAKE_PREFIX_PATH "$ENV{ORTOOLS_ROOT}")
endif()
find_package(ortools CONFIG REQUIRED)
message(STATUS "Using OR-Tools from: ${ortools_DIR}")

# ---------------------------------------------------------------------------
# node-addon-api headers (cmake-js supplies CMAKE_JS_INC / CMAKE_JS_SRC / CMAKE_JS_LIB)
# ---------------------------------------------------------------------------
execute_process(
  COMMAND node -p "require('node-addon-api').include_dir"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
string(REPLACE "\n" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})

add_library(${PROJECT_NAME} SHARED
  src/addon.cc
  ${CMAKE_JS_SRC}
)

set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  # Let the loader find libortools.so / libortools.dylib next to where it was built.
  BUILD_RPATH "$<TARGET_FILE_DIR:ortools::ortools>"
  INSTALL_RPATH "$<TARGET_FILE_DIR:ortools::ortools>"
  BUILD_WITH_INSTALL_RPATH TRUE
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_INC}
  ${NODE_ADDON_API_DIR}
)

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=8
  NAPI_DISABLE_CPP_EXCEPTIONS
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB}
  ortools::ortools
)

if(MSVC)
  # Windows: node.lib delay-load hook is in CMAKE_JS_SRC; also silence noisy warnings.
  target_compile_options(${PROJECT_NAME} PRIVATE /EHsc /W3 /bigobj)
  # Generate node.lib if needed (cmake-js >= 7)
  if(CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    set(CMAKE_JS_NODELIB_TARGET ${CMAKE_JS_NODELIB_TARGET} CACHE INTERNAL "")
    add_custom_command(OUTPUT ${CMAKE_JS_NODELIB_TARGET}
      COMMAND lib /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
  endif()
else()
  target_compile_options(${PROJECT_NAME} PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()
