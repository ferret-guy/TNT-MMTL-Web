// Eigen 3.4.0 blocked LU, preserving the solver's column-major layout.
#include <cmath>
#include <cstdio>
#include <algorithm>
#include "optimized_lu.h"
static int progress_order = 0, progress_last = 0;
static void lu_progress(int rows, int cols, int k, int bs, double part) {
  if (rows != progress_order || cols != progress_order) return;
  const double before = std::pow(1.0-double(k)/rows,3);
  const double after = std::pow(1.0-double(k+bs)/rows,3);
  const int done = std::min(rows-1, int(rows*(1-std::cbrt(before+(after-before)*part))));
  if (done > progress_last) {
    std::printf("MMTL_PROGRESS factorization %d %d\n",done,rows);
    progress_last = done;
  }
}
#define EIGEN_TNT_LU_PROGRESS(rows,cols,k,bs,part) lu_progress(rows,cols,k,bs,part)
#define EIGEN_DONT_PARALLELIZE
#define EIGEN_MPL2_ONLY
#include <Eigen/LU>
using Matrix = Eigen::Matrix<double,Eigen::Dynamic,Eigen::Dynamic,Eigen::ColMajor>;
#ifdef TNT_LU_VALIDATE
static Matrix validation_original;
#endif
using View = Eigen::Map<Matrix,0,Eigen::OuterStride<>>;
void tnt_lu_factor(int* n,double* a,double* lu,int* lda,int* piv,int* status) {
  View input(a,*n,*n,Eigen::OuterStride<>(*lda));
  double* storage = lu ? lu : a;
  View matrix(storage,*n,*n,Eigen::OuterStride<>(*lda));
  if (storage != a) matrix = input;
#ifdef TNT_LU_VALIDATE
  validation_original = input;
#endif
  progress_order = *n; progress_last = 0;
  std::printf("MMTL_LU Eigen-3.4.0 SIMD\nMMTL_PROGRESS factorization 0 %d\n",*n);
  int swaps = 0;
  const auto zero = Eigen::internal::partial_lu_impl<double,Eigen::ColMajor,int,Eigen::Dynamic>::blocked_lu(
    *n,*n,storage,*lda,piv,swaps,64);
  // Match the legacy failure contract, including nonfinite factors.
  *status = zero < 0 && matrix.allFinite() ? 1 : 0;
  if (!*status) std::fprintf(stderr,"Error: singular or nonfinite Eigen LU factorization\n");
  std::printf("MMTL_PROGRESS factorization %d %d\n",*n,*n);
}
void tnt_lu_solve(int* n,double* a,double* x,double* b,int* lda,int* piv,int* status) {
  View matrix(a,*n,*n,Eigen::OuterStride<>(*lda));
#ifdef TNT_LU_VALIDATE
  const Eigen::VectorXd validation_rhs = Eigen::Map<Eigen::VectorXd>(b,*n);
#endif
  Eigen::Map<Eigen::VectorXd> result(x ? x : b,*n);
  if (x && x != b) result = Eigen::Map<Eigen::VectorXd>(b,*n);
  for (int i=0;i<*n;++i) if (piv[i]!=i) std::swap(result[i],result[piv[i]]);
  matrix.triangularView<Eigen::UnitLower>().solveInPlace(result);
  matrix.triangularView<Eigen::Upper>().solveInPlace(result);
  *status = result.allFinite() ? 1 : 0;
#ifdef TNT_LU_VALIDATE
  const Eigen::VectorXd residual = validation_original * result - validation_rhs;
  const double scale = validation_original.cwiseAbs().rowwise().sum().maxCoeff()*result.cwiseAbs().maxCoeff()
    + validation_rhs.cwiseAbs().maxCoeff();
  std::printf("MMTL_LU_RESIDUAL %.17g\n",residual.cwiseAbs().maxCoeff()/scale);
#endif
}
