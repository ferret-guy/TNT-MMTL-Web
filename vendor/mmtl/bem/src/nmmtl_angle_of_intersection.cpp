
/*
  
  FACILITY:  NMMTL
  
  MODULE DESCRIPTION:
  
  contains the nmmtl_angle_of_intersection function.
  
  AUTHOR(S):
  
  Kevin J. Buchs
  
  CREATION DATE:  27-NOV-1991 09:54:06
  
  COPYRIGHT:   Copyright (C) 1992 by Mayo Foundation. All rights reserved.
  
  */


/*
 *******************************************************************
 **  INCLUDE FILES
 *******************************************************************
 */

#include "nmmtl.h"


/*
 *******************************************************************
 **  STRUCTURE DECLARATIONS AND TYPE DEFINTIONS
 *******************************************************************
 */
/*
 *******************************************************************
 **  MACRO DEFINITIONS
 *******************************************************************
 */
/*
 *******************************************************************
 **  PREPROCESSOR CONSTANTS
 *******************************************************************
 */
/*
 *******************************************************************
 **  GLOBALS
 *******************************************************************
 */
/*
 *******************************************************************
 **  FUNCTION DECLARATIONS
 *******************************************************************
 */
/*
 *******************************************************************
 **  FUNCTION DEFINITIONS
 *******************************************************************
 */


/*
  
  FUNCTION NAME:  nmmtl_angle_of_intersection
  
  FUNCTIONAL DESCRIPTION:
  
  Find the angle of intersection of two line segments given by the
  vectors (displacements).  This angle is the angle needed to rotate
  from the first vector to the second vector.  Counterclockwise is
  defined as the positive direction.  First we do the dot product
  between the two vectors.  This gives us the angle, with no sign
  orientation.  Next the vector (cross) product is computed to give the
  sign.
  
  
  FORMAL PARAMETERS:
  
  float x1, y1   x and y displacement of first line segment
  float x2, y2   x and y displacement of second line segment
  
  RETURN VALUE:
  
  the angle of intersection
  
  CALLING SEQUENCE:
  
  intersection_angle = nmmtl_angle_of_intersection( deltax1,deltay1,
  deltax2,deltay2);
  
  */


float nmmtl_angle_of_intersection(float x1, float y1, float x2, float y2)
{
  /* tnt-web patch: originally acos(dot/(len1*len2)) with the sign taken
     from the cross product.  Near anti-parallel vectors the acos form is
     ill-conditioned and its last-ulp value depends on the platform's libm
     and float/double overload resolution; callers guard the straight-line
     case with exact comparisons against PI (see nmmtl_det_intersections),
     so a one-ulp difference flips dielectric bookkeeping (observed as
     wrong epsilon on uncovered trapezoid corners under WebAssembly).

     atan2(cross, dot) is algebraically identical, better conditioned, and
     returns exactly +/-pi for anti-parallel vectors on every IEEE libm,
     which the callers' "< PI" guards then exclude deterministically
     (float(pi) = 3.14159274 > double PI). */

  double dot   = (double)x1 * (double)x2 + (double)y1 * (double)y2;
  double cross = (double)x1 * (double)y2 - (double)x2 * (double)y1;

  return((float)atan2(cross, dot));
}
