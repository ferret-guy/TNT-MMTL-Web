#include <cmath>
#include <cstdio>
#include <limits>
#include "optimized_lu.h"
int main() {
  int n=5, lda=7, piv[5], status;
  double a[35]={}, original[35]={}, rhs[5]={}, answer[5]={};
  const double expected[5]={1,-2,3,-4,5};
  for(int j=0;j<n;++j) for(int i=0;i<n;++i) {
    original[j*lda+i]=a[j*lda+i]=(i==j ? 8.0 : ((i*7+j*3)%11)-5.0);
  }
  // Force a nontrivial first pivot.
  original[0]=a[0]=0.01;
  for(int i=0;i<n;++i) for(int j=0;j<n;++j) rhs[i]+=original[j*lda+i]*expected[j];
  tnt_lu_factor(&n,a,a,&lda,piv,&status);
  if(status!=1) return 1;
  tnt_lu_solve(&n,a,answer,rhs,&lda,piv,&status);
  if(status!=1) return 2;
  for(int i=0;i<n;++i) if(std::abs(answer[i]-expected[i])>1e-12) return 3;
  for(int j=0;j<n;++j) for(int i=n;i<lda;++i) if(a[j*lda+i]!=0) return 4;
  for(double &v:a) v=0;
  tnt_lu_factor(&n,a,a,&lda,piv,&status);
  if(status!=0) return 5;
  a[0]=std::numeric_limits<double>::quiet_NaN();
  tnt_lu_factor(&n,a,a,&lda,piv,&status);
  if(status!=0) return 6;
  puts("PASS: pivoting, padded leading dimension, solve residual, singular and nonfinite rejection");
}
