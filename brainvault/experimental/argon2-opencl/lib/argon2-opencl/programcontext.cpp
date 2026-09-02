#include "programcontext.h"

#include "kernelloader.h"

#include <cstdlib>

namespace argon2 {
namespace opencl {

ProgramContext::ProgramContext(
        const GlobalContext *globalContext,
        const std::vector<Device> &devices,
        Type type, Version version)
    : globalContext(globalContext), devices(), type(type), version(version)
{
    this->devices.reserve(devices.size());
    for (auto &device : devices) {
        this->devices.push_back(device.getCLDevice());
    }
    context = cl::Context(this->devices);

    const char *configured = std::getenv("BRAINVAULT_OPENCL_KERNEL_DIR");
    const std::string kernelDirectory = configured == nullptr
        ? "./data/kernels"
        : configured;
    program = KernelLoader::loadArgon2Program(
                context, kernelDirectory, type, version);
}

} // namespace opencl
} // namespace argon2
