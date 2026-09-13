#ifndef NMMTL_PARALLEL_ASSEMBLY_H
#define NMMTL_PARALLEL_ASSEMBLY_H

#include <atomic>
#include <cstdlib>
#ifdef __EMSCRIPTEN_PTHREADS__
#include <pthread.h>
#include <thread>
#include <chrono>
#include <emscripten/threading.h>
#endif

// Each matrix column has exactly one owner. Adjacent elements may share
// endpoint nodes, so assigning elements alone would introduce data races.
// Blocks spread expensive conductor rows across workers, while preserving
// the original accumulation order within every matrix entry.
struct NmmtlAssemblyPartition {
  int index, count;
  std::atomic<int> completed{0};
  std::atomic<bool> finished{false};
  bool owns(int node) const { return (node / 32) % count == index; }
  bool touches(const int *nodes) const {
    for (int i = 0; i < INTERP_PTS; ++i) if (owns(nodes[i])) return true;
    return false;
  }
  void advance(const int *nodes, int total) {
    if (owns(nodes[0])) {
      const int done = ++completed;
      if (count == 1) printf("MMTL_PROGRESS assembly %d %d\n", done, total);
    }
  }
};

template<class Work>
static void nmmtl_parallel_assembly(int total, Work work) {
  int count = 1;
#ifdef __EMSCRIPTEN_PTHREADS__
  if (total >= 384) {
    count = emscripten_num_logical_cores() - 1;
    if (count < 1) count = 1;
    if (count > 4) count = 4;
    const char *override_count = getenv("MMTL_ASSEMBLY_THREADS");
    if (override_count) {
      const int requested = atoi(override_count);
      if (requested >= 1 && requested <= 4) count = requested;
    }
  }
#endif
  printf("MMTL_PARALLEL %d\n", count);
  printf("MMTL_PROGRESS assembly 0 %d\n", total);
  NmmtlAssemblyPartition partitions[4];
  for (int i = 0; i < count; ++i) { partitions[i].index = i; partitions[i].count = count; }
  if (count == 1) { work(partitions[0]); return; }
#ifdef __EMSCRIPTEN_PTHREADS__
  struct Context { Work *work; NmmtlAssemblyPartition *partition; } contexts[4];
  pthread_t threads[4];
  bool launched[4] = {false, false, false, false};
  for (int i = 0; i < count; ++i) {
    contexts[i] = {&work, &partitions[i]};
    launched[i] = pthread_create(&threads[i], nullptr, [](void *arg) -> void * {
      Context *context = static_cast<Context *>(arg);
      (*context->work)(*context->partition);
      context->partition->finished.store(true);
      return nullptr;
    }, &contexts[i]) == 0;
    if (!launched[i]) { work(partitions[i]); partitions[i].finished.store(true); }
  }
  int reported = 0;
  for (;;) {
    int completed = 0, finished = 0;
    for (int i = 0; i < count; ++i) {
      completed += partitions[i].completed.load();
      finished += partitions[i].finished.load() ? 1 : 0;
    }
    // Only the coordinating solver thread touches stdout / Emscripten FS.
    // Hold the final tick until shared-boundary work has also completed.
    if (completed >= total && finished != count) completed = total - 1;
    if (completed > reported) {
      printf("MMTL_PROGRESS assembly %d %d\n", completed, total);
      reported = completed;
    }
    if (finished == count) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  for (int i = 0; i < count; ++i) if (launched[i]) pthread_join(threads[i], nullptr);
#endif
}
#endif
