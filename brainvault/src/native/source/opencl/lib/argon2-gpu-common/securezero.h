#ifndef ARGON2_SECUREZERO_H
#define ARGON2_SECUREZERO_H

#include <cstddef>

namespace argon2 {

inline void secureZero(void *pointer, std::size_t size)
{
    if (pointer == nullptr || size == 0) return;
    volatile unsigned char *bytes = static_cast<volatile unsigned char *>(pointer);
    while (size-- != 0) *bytes++ = 0;
}

} // namespace argon2

#endif // ARGON2_SECUREZERO_H
