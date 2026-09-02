#ifndef ARGON2_OPENCL_KERNELRUNNER_H
#define ARGON2_OPENCL_KERNELRUNNER_H

#include "programcontext.h"
#include "argon2-gpu-common/argon2params.h"

namespace argon2 {
namespace opencl {

class KernelRunner
{
private:
    const ProgramContext *programContext;
    const Argon2Params *params;

    std::uint32_t batchSize;
    bool bySegment;
    bool precompute;

    cl::CommandQueue queue;
    cl::Kernel kernel;
    cl::Buffer memoryBuffer, refsBuffer;
    cl::Event start, end;

    std::size_t memorySize;
    bool memoryDirty;

    void precomputeRefs();

public:
    std::uint32_t getMinLanesPerBlock() const
    {
        return bySegment ? 1 : params->getLanes();
    }
    std::uint32_t getMaxLanesPerBlock() const { return params->getLanes(); }

    std::uint32_t getMinJobsPerBlock() const { return 1; }
    std::uint32_t getMaxJobsPerBlock() const { return batchSize; }

    std::size_t getBatchSize() const { return batchSize; }

    KernelRunner(const ProgramContext *programContext,
                 const Argon2Params *params, const Device *device,
                 std::size_t batchSize, bool bySegment, bool precompute);
    ~KernelRunner() noexcept;

    void *mapInputMemory(std::size_t jobId);
    void unmapInputMemory(void *memory);

    void *mapOutputMemory(std::size_t jobId);
    void unmapOutputMemory(void *memory);

    void run(std::uint32_t lanesPerBlock, std::uint32_t jobsPerBlock);
    float finish();
    void clearMemory();
};

} // namespace opencl
} // namespace argon2

#endif // ARGON2_OPENCL_KERNELRUNNER_H
