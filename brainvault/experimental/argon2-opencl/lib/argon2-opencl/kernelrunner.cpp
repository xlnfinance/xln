#include "kernelrunner.h"

#include <stdexcept>

#ifndef NDEBUG
#include <iostream>
#endif

#define THREADS_PER_LANE 32

namespace argon2 {
namespace opencl {

enum {
    ARGON2_REFS_PER_BLOCK = ARGON2_BLOCK_SIZE / (2 * sizeof(cl_uint)),
};

KernelRunner::KernelRunner(const ProgramContext *programContext,
                           const Argon2Params *params, const Device *device,
                           std::size_t batchSize, bool bySegment, bool precompute)
    : programContext(programContext), params(params), batchSize(batchSize),
      bySegment(bySegment), precompute(precompute),
      memorySize(params->getMemorySize() * batchSize), memoryDirty(true)
{
    auto context = programContext->getContext();
    std::uint32_t passes = params->getTimeCost();
    std::uint32_t lanes = params->getLanes();
    std::uint32_t segmentBlocks = params->getSegmentBlocks();

    queue = cl::CommandQueue(context, device->getCLDevice(),
                             CL_QUEUE_PROFILING_ENABLE);

#ifndef NDEBUG
        std::cerr << "[INFO] Allocating " << memorySize << " bytes for memory..."
                  << std::endl;
#endif

    memoryBuffer = cl::Buffer(context, CL_MEM_READ_WRITE, memorySize);

    Type type = programContext->getArgon2Type();
    if ((type == ARGON2_I || type == ARGON2_ID) && precompute) {
        std::uint32_t segments =
                type == ARGON2_ID
                ? lanes * (ARGON2_SYNC_POINTS / 2)
                : passes * lanes * ARGON2_SYNC_POINTS;

        std::size_t refsSize = segments * segmentBlocks * sizeof(cl_uint) * 2;

#ifndef NDEBUG
        std::cerr << "[INFO] Allocating " << refsSize << " bytes for refs..."
                  << std::endl;
#endif

        refsBuffer = cl::Buffer(context, CL_MEM_READ_WRITE, refsSize);

        precomputeRefs();
    }

    static const char *KERNEL_NAMES[2][2] = {
        {
            "argon2_kernel_oneshot",
            "argon2_kernel_segment",
        },
        {
            "argon2_kernel_oneshot_precompute",
            "argon2_kernel_segment_precompute",
        }
    };

    kernel = cl::Kernel(programContext->getProgram(),
                        KERNEL_NAMES[precompute][bySegment]);
    kernel.setArg<cl::Buffer>(1, memoryBuffer);
    if (precompute) {
        kernel.setArg<cl::Buffer>(2, refsBuffer);
        kernel.setArg<cl_uint>(3, passes);
        kernel.setArg<cl_uint>(4, lanes);
        kernel.setArg<cl_uint>(5, segmentBlocks);
    } else {
        kernel.setArg<cl_uint>(2, passes);
        kernel.setArg<cl_uint>(3, lanes);
        kernel.setArg<cl_uint>(4, segmentBlocks);
    }
}

KernelRunner::~KernelRunner() noexcept
{
    if (!memoryDirty) return;
    try {
        clearMemory();
    } catch (...) {
        /* Process teardown is the final fail-closed boundary. */
    }
}

void KernelRunner::precomputeRefs()
{
    std::uint32_t passes = params->getTimeCost();
    std::uint32_t lanes = params->getLanes();
    std::uint32_t segmentBlocks = params->getSegmentBlocks();
    std::uint32_t segmentAddrBlocks =
            (segmentBlocks + ARGON2_REFS_PER_BLOCK - 1)
            / ARGON2_REFS_PER_BLOCK;
    std::uint32_t segments = programContext->getArgon2Type() == ARGON2_ID
            ? lanes * (ARGON2_SYNC_POINTS / 2)
            : passes * lanes * ARGON2_SYNC_POINTS;

    std::size_t shmemSize = THREADS_PER_LANE * sizeof(cl_uint) * 2;

    cl::Kernel kernel = cl::Kernel(programContext->getProgram(),
                                   "argon2_precompute_kernel");
    kernel.setArg<cl::LocalSpaceArg>(0, { shmemSize });
    kernel.setArg<cl::Buffer>(1, refsBuffer);
    kernel.setArg<cl_uint>(2, passes);
    kernel.setArg<cl_uint>(3, lanes);
    kernel.setArg<cl_uint>(4, segmentBlocks);

    cl::NDRange globalRange { THREADS_PER_LANE * segments * segmentAddrBlocks };
    cl::NDRange localRange { THREADS_PER_LANE };
    queue.enqueueNDRangeKernel(kernel, cl::NullRange, globalRange, localRange);
    queue.finish();
}

void *KernelRunner::mapInputMemory(std::size_t jobId)
{
    memoryDirty = true;
    std::size_t memorySize = params->getMemorySize();
    std::size_t mappedSize = params->getLanes() * 2 * ARGON2_BLOCK_SIZE;
    return queue.enqueueMapBuffer(memoryBuffer, true, CL_MAP_WRITE,
                                  memorySize * jobId, mappedSize);
}

void KernelRunner::unmapInputMemory(void *memory)
{
    queue.enqueueUnmapMemObject(memoryBuffer, memory);
}

void *KernelRunner::mapOutputMemory(std::size_t jobId)
{
    std::size_t memorySize = params->getMemorySize();
    std::size_t mappedSize = static_cast<std::size_t>(params->getLanes())
            * ARGON2_BLOCK_SIZE;
    std::size_t mappedOffset = memorySize * (jobId + 1) - mappedSize;
    return queue.enqueueMapBuffer(memoryBuffer, true, CL_MAP_READ,
                                  mappedOffset, mappedSize);
}

void KernelRunner::unmapOutputMemory(void *memory)
{
    queue.enqueueUnmapMemObject(memoryBuffer, memory);
}

void KernelRunner::run(std::uint32_t lanesPerBlock, std::uint32_t jobsPerBlock)
{
    memoryDirty = true;
    std::uint32_t lanes = params->getLanes();
    std::uint32_t passes = params->getTimeCost();

    if (bySegment) {
        if (lanesPerBlock > lanes || lanes % lanesPerBlock != 0) {
            throw std::logic_error("Invalid lanesPerBlock!");
        }
    } else {
        if (lanesPerBlock != lanes) {
            throw std::logic_error("Invalid lanesPerBlock!");
        }
    }

    if (jobsPerBlock > batchSize || batchSize % jobsPerBlock != 0) {
        throw std::logic_error("Invalid jobsPerBlock!");
    }

    cl::NDRange globalRange { THREADS_PER_LANE * lanes, batchSize };
    cl::NDRange localRange { THREADS_PER_LANE * lanesPerBlock, jobsPerBlock };

    queue.enqueueMarker(&start);

    std::size_t shmemSize = THREADS_PER_LANE * lanesPerBlock * jobsPerBlock
            * sizeof(cl_uint) * 2;
    kernel.setArg<cl::LocalSpaceArg>(0, { shmemSize });
    if (bySegment) {
        for (std::uint32_t pass = 0; pass < passes; pass++) {
            for (std::uint32_t slice = 0; slice < ARGON2_SYNC_POINTS; slice++) {
                kernel.setArg<cl_uint>(precompute ? 6 : 5, pass);
                kernel.setArg<cl_uint>(precompute ? 7 : 6, slice);
                queue.enqueueNDRangeKernel(kernel, cl::NullRange,
                                           globalRange, localRange);
            }
        }
    } else {
        queue.enqueueNDRangeKernel(kernel, cl::NullRange,
                                   globalRange, localRange);
    }

    queue.enqueueMarker(&end);
}

float KernelRunner::finish()
{
    end.wait();

    cl_ulong nsStart = start.getProfilingInfo<CL_PROFILING_COMMAND_END>();
    cl_ulong nsEnd   = end.getProfilingInfo<CL_PROFILING_COMMAND_END>();

    return (nsEnd - nsStart) / (1000.0F * 1000.0F);
}

void KernelRunner::clearMemory()
{
    if (!memoryDirty) return;
    const cl_uint zero = 0;
    queue.enqueueFillBuffer(memoryBuffer, zero, 0, memorySize);
    queue.finish();
    memoryDirty = false;
}

} // namespace opencl
} // namespace argon2
