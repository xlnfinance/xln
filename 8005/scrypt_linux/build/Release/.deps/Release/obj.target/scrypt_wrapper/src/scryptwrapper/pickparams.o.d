cmd_Release/obj.target/scrypt_wrapper/src/scryptwrapper/pickparams.o := cc '-DNODE_GYP_MODULE_NAME=scrypt_wrapper' '-DUSING_UV_SHARED=1' '-DUSING_V8_SHARED=1' '-DV8_DEPRECATION_WARNINGS=1' '-D_LARGEFILE_SOURCE' '-D_FILE_OFFSET_BITS=64' '-DHAVE_CONFIG_H' -I/root/.node-gyp/9.3.0/include/node -I/root/.node-gyp/9.3.0/src -I/root/.node-gyp/9.3.0/deps/uv/include -I/root/.node-gyp/9.3.0/deps/v8/include -I../src/scryptwrapper/inc -I../src -I../scrypt/scrypt-1.2.0/libcperciva/alg -I../scrypt/scrypt-1.2.0/libcperciva/util -I../scrypt/scrypt-1.2.0/lib/crypto -I../scrypt/scrypt-1.2.0/lib/util -I../scrypt/scrypt-1.2.0/lib/scryptenc  -fPIC -pthread -Wall -Wextra -Wno-unused-parameter -m64 -O3 -fno-omit-frame-pointer  -MMD -MF ./Release/.deps/Release/obj.target/scrypt_wrapper/src/scryptwrapper/pickparams.o.d.raw   -c -o Release/obj.target/scrypt_wrapper/src/scryptwrapper/pickparams.o ../src/scryptwrapper/pickparams.c
Release/obj.target/scrypt_wrapper/src/scryptwrapper/pickparams.o: \
 ../src/scryptwrapper/pickparams.c ../src/scryptwrapper/inc/pickparams.h \
 ../scrypt/scrypt-1.2.0/lib/scryptenc/scryptenc_cpuperf.h \
 ../src/util/memlimit.h
../src/scryptwrapper/pickparams.c:
../src/scryptwrapper/inc/pickparams.h:
../scrypt/scrypt-1.2.0/lib/scryptenc/scryptenc_cpuperf.h:
../src/util/memlimit.h: