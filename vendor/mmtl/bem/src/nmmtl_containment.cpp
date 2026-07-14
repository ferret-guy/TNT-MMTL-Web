
/*
  
  FACILITY:  NMMTL
  
  MODULE DESCRIPTION:
  
  Contains:
  
  nmmtl_seg_in_die_rect
  nmmtl_circle_in_die_rect
  
  AUTHOR(S):
  
  Kevin J. Buchs
  
  CREATION DATE:  Wed Feb  5 08:19:24 1992
  
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
  
  FUNCTION NAME:  nmmtl_seg_in_die_rect
  
  
  FUNCTIONAL DESCRIPTION:
  
  Determine if a line segment is contained within a dielectric rectangle.
  All we need to do is check the x and y ranges for inclusion.
  
  FORMAL PARAMETERS:
  
  DIELECTRICS_P die_rect   the dielectric rectangle
  LINESEG_P line           the line segment
  
  RETURN VALUE:
  
  TRUE OR FALSE
  
  CALLING SEQUENCE:
  
  intersection = nmmtl_seg_in_die_rect(dielectric,line_seg);
  
  */

int nmmtl_seg_in_die_rect(DIELECTRICS_P die_rect,LINESEG_P line)
{
  if(die_rect->primitive == POLYGON)
  {
    int i;
    for(i=0;i<2;i++)
    {
      const double y = line->y[i];
      double f, left, right;
      if(y < die_rect->y0 || y > die_rect->y1) return(FALSE);
      f = die_rect->y1 == die_rect->y0 ? 0.0 :
        (y-die_rect->y0)/(die_rect->y1-die_rect->y0);
      left = die_rect->x0 + f*(die_rect->top_x0-die_rect->x0);
      right = die_rect->x1 + f*(die_rect->top_x1-die_rect->x1);
      if(line->x[i] < left || line->x[i] > right) return(FALSE);
    }
    return(TRUE);
  }
  if(line->x[0] >= die_rect->x0 && line->x[0] <= die_rect->x1 &&
     line->x[1] >= die_rect->x0 && line->x[1] <= die_rect->x1 &&
     line->y[0] >= die_rect->y0 && line->y[0] <= die_rect->y1 &&
     line->y[1] >= die_rect->y0 && line->y[1] <= die_rect->y1)
  {
    return(TRUE);
  }
  else
  {
    return(FALSE);
  }
}



/*
  
  FUNCTION NAME:  nmmtl_circle_in_die_rect
  
  
  FUNCTIONAL DESCRIPTION:
  
  Determine if a circle is contained within a dielectric rectangle.
  All we need to do is check the x and y ranges for inclusion.
  
  FORMAL PARAMETERS:
  
  DIELECTRICS_P die_rect      the dielectric rectangle
  POINT_P center         center of the circle
  double radius           radius of the circle
  
  RETURN VALUE:
  
  TRUE OR FALSE
  
  CALLING SEQUENCE:
  
  if(nmmtl_circle_in_die_rect(die,&center,radius))
  
  */

int nmmtl_circle_in_die_rect(DIELECTRICS_P die_rect,POINT_P center,
			     double radius)
{
  double top,bot,left,right;
  
  if(die_rect->primitive == POLYGON)
  {
    /* Bottom-left, bottom-right, top-right, top-left: counter-clockwise.
       A circle lies in this convex trapezoid iff its center is at least one
       radius inside every directed edge. */
    const double x[4] = { die_rect->x0, die_rect->x1,
                          die_rect->top_x1, die_rect->top_x0 };
    const double y[4] = { die_rect->y0, die_rect->y0,
                          die_rect->y1, die_rect->y1 };
    const double scale = fabs(die_rect->x1 - die_rect->x0) +
                         fabs(die_rect->y1 - die_rect->y0) + radius;
    const double tolerance = 256.0 * DBL_EPSILON *
                             (scale > 1.0e-30 ? scale : 1.0e-30);
    int edge;
    for(edge = 0; edge < 4; ++edge)
    {
      const int next = (edge + 1) % 4;
      const double dx = x[next] - x[edge];
      const double dy = y[next] - y[edge];
      const double length = hypot(dx, dy);
      const double signed_distance =
        (dx * (center->y - y[edge]) - dy * (center->x - x[edge])) /
        length;
      if(signed_distance + tolerance < radius) return(FALSE);
    }
    return(TRUE);
  }

  top = center->y + radius;
  bot = center->y - radius;
  left = center->x - radius;
  right = center->x + radius;
  
  if(bot >= die_rect->y0 && top <= die_rect->y1 &&
     left >= die_rect->x0 && right <= die_rect->x1)
  {
    return(TRUE);
  }
  else
  {
    return(FALSE);
  }
  
}
