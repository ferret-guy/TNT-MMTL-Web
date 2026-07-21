/*
  
  FACILITY:   NMMTL
  
  MODULE DESCRIPTION:
  
  Contains the function nmmtl_combine_die
  
  AUTHOR(S):
  
  Kevin J. Buchs
  
  CREATION DATE:   26-JUL-1991 15:56:27
  
  COPYRIGHT:   Copyright (C) 1992 by Mayo Foundation. All rights reserved.
  
  */


/*
 *******************************************************************
 **  INCLUDE FILES
 *******************************************************************
 */


#include "nmmtl.h"

/* Return the material selected by the same last-object-wins ordering used
   when conductor arcs are classified.  This also lets a closed shape be
   assembled from touching trapezoids without leaving zero-contrast internal
   boundaries in the BEM matrix. */
static int nmmtl_point_in_dielectric(DIELECTRICS_P dielectric,
                                     double x, double y)
{
  const double scale = fabs(x) + fabs(y) + fabs(dielectric->x0) +
    fabs(dielectric->x1) + fabs(dielectric->y0) +
    fabs(dielectric->y1) + 1.0;
  const double tolerance = 128.0 * DBL_EPSILON * scale;
  if(y < dielectric->y0 - tolerance || y > dielectric->y1 + tolerance)
    return(FALSE);

  double left = dielectric->x0;
  double right = dielectric->x1;
  if(dielectric->primitive == POLYGON) {
    const double height = dielectric->y1 - dielectric->y0;
    const double fraction = fabs(height) <= DBL_MIN ? 0.0 :
      (y - dielectric->y0) / height;
    left += fraction * (dielectric->top_x0 - dielectric->x0);
    right += fraction * (dielectric->top_x1 - dielectric->x1);
  }
  return(x >= left - tolerance && x <= right + tolerance);
}

static float nmmtl_point_epsilon(DIELECTRICS_P dielectrics,
                                 double x, double y)
{
  for(DIELECTRICS_P dielectric = dielectrics; dielectric != NULL;
      dielectric = dielectric->next)
    if(nmmtl_point_in_dielectric(dielectric, x, y))
      return(dielectric->constant);
  return(AIR_CONSTANT);
}

static void nmmtl_reclassify_dielectric_segments(
  DIELECTRICS_P dielectrics, DIELECTRIC_SEGMENTS_P *segments)
{
  DIELECTRIC_SEGMENTS_P segment = *segments;
  DIELECTRIC_SEGMENTS_P previous = NULL;
  while(segment != NULL) {
    DIELECTRIC_SEGMENTS_P next = segment->next;
    double x0, y0, x1, y1;
    nmmtl_die_seg_endpoints(segment, &x0, &y0, &x1, &y1);
    const double dx = x1 - x0;
    const double dy = y1 - y0;
    const double length = hypot(dx, dy);
    int keep = length > DBL_MIN;

    if(keep) {
      /* Every dielectric-segment normal points left of its endpoint order:
         up for horizontal, left for vertical, and the geometric left normal
         for a general/sloped segment. */
      const double nx = -dy / length;
      const double ny = dx / length;
      const double delta = fmax(length * 1.0e-7, 1.0e-12);
      const double mx = 0.5 * (x0 + x1);
      const double my = 0.5 * (y0 + y1);
      segment->epsilonplus = nmmtl_point_epsilon(
        dielectrics, mx + delta * nx, my + delta * ny);
      segment->epsilonminus = nmmtl_point_epsilon(
        dielectrics, mx - delta * nx, my - delta * ny);
      keep = segment->epsilonplus != segment->epsilonminus;
    }

    if(!keep) {
      if(previous == NULL) *segments = next;
      else previous->next = next;
      free(segment);
    } else {
      segment->length = length;
      previous = segment;
    }
    segment = next;
  }
}


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
  
  FUNCTION NAME:  nmmtl_combine_die
  
  
  FUNCTIONAL DESCRIPTION:
  
  Pair up tops and bottoms, and lefts and rights of dielectric
  rectangles to form dielectric interfaces.  Calls nmmtl_form_die_subseg
  to form top, bottom, left and right subsegments from the pieces of the
  dielectric rectangles.  Then, calls nmmtl_merge_die_subseg twice, once
  for horizontal and once for vertical subsegments.
  
  FORMAL PARAMETERS:
  
  struct dielectric *dielectrics
  
  Raw input dielectric geometric structures
  
  int plane_segments
  
  How many segments to divide each plane into.
  
  int gnd_planes
  
  How many ground planes there are
  
  double top_of_bottom_plane
  
  Where the bottom ground plane meets a dielectric
  
  double bottom_of_top_plane
  
  Where the top ground plane, if any, meets a dielectric
  
  double left_of_gnd_planes
  double right_of_gnd_planes
  
  Left and right extents of the ground planes.
  
  struct dielectric_segments **dielectric_segments
  
  Return list of dielectric interface segments.
  
  SORTED_GND_DIE_LIST_P *lower_sorted_gdl,
  SORTED_GND_DIE_LIST_P *upper_sorted_gdl
  - lists of ground plane-dielectric intersections created by this function
  
  
  RETURN VALUE:
  
  FAIL or SUCCESS
  
  CALLING SEQUENCE:
  
  status = nmmtl_combine_die(dielectrics,plane_segments,
  gnd_planes,top_of_bottom_plane,
  bottom_of_top_plane,left_of_gnd_planes,
  right_of_gnd_planes,
  &dielectric_segments,
  &lower_sorted_gdl,&upper_sorted_gdl)
  */


int nmmtl_combine_die(struct dielectric *dielectrics,
		      int plane_segments,
		      int gnd_planes,double top_of_bottom_plane,
		      double bottom_of_top_plane,double left_of_gnd_planes,
					double right_of_gnd_planes,
		      struct dielectric_segments **dielectric_segments,
		      SORTED_GND_DIE_LIST_P *lower_sorted_gdl,
		      SORTED_GND_DIE_LIST_P *upper_sorted_gdl)
{
  int status;
  int segment_number = 0;
  struct dielectric_sub_segments *top_seg;
  struct dielectric_sub_segments *bottom_seg;
  struct dielectric_sub_segments *left_seg;
  struct dielectric_sub_segments *right_seg;
  struct dielectric_segments *sloped_segments;
  
  
  top_seg = NULL;
  bottom_seg = NULL;
  left_seg = NULL;
  right_seg = NULL;
  sloped_segments = NULL;
  
  if(gnd_planes < 2)
  {
    /* Trick: */
    /* if only one ground plane, offset where the top of the dielectrics */
    /* should be to avoid including the top to the top dielectric in the */
    /* subsegments list */
    
    status = nmmtl_form_die_subseg(plane_segments,dielectrics,
				   top_of_bottom_plane,
				   1.0 + bottom_of_top_plane,
				   left_of_gnd_planes,right_of_gnd_planes,
				   &top_seg,&bottom_seg,
				   &left_seg,&right_seg,
				   &sloped_segments,
				   lower_sorted_gdl,
				   upper_sorted_gdl);
  }
  else 
  {
    
    /* else, check real boundary and exclude those dielectric sub segments */
    /* which are touching the top ground plane. */
    
    status = nmmtl_form_die_subseg(plane_segments,dielectrics,
				   top_of_bottom_plane,bottom_of_top_plane,
				   left_of_gnd_planes,right_of_gnd_planes,
				   &top_seg,&bottom_seg,
				   &left_seg,&right_seg,
				   &sloped_segments,
				   lower_sorted_gdl,
				   upper_sorted_gdl);
  }
  if(status != SUCCESS) return(status);

  /* Sloped sides cannot participate in the legacy axis-aligned pairing
     pass. They are already complete dielectric/air interfaces. */
  while(sloped_segments != NULL)
  {
    struct dielectric_segments *next = sloped_segments->next;
    sloped_segments->segment_number = segment_number++;
    sloped_segments->next = *dielectric_segments;
    *dielectric_segments = sloped_segments;
    sloped_segments = next;
  }
  
  
  /* normal is UP, so pass in top first, since it will point from top */
  /* segments into bottom segments when the interface is put together. */
  
  status = nmmtl_merge_die_subseg(HORIZONTAL_ORIENTATION,&segment_number,
				  bottom_of_top_plane,&top_seg,&bottom_seg,
				  dielectric_segments);
  
  if(status != SUCCESS) return(status);
  
  
  /* normal is to left, so pass in left first, and to point left you */
  /* would go from the left boundary into the right boundary */
  
  status = nmmtl_merge_die_subseg(VERTICAL_ORIENTATION,&segment_number,
				  bottom_of_top_plane,&left_seg,&right_seg,
				  dielectric_segments);
  
  if(status != SUCCESS) return(status);

  nmmtl_reclassify_dielectric_segments(dielectrics, dielectric_segments);
  
  return(SUCCESS);
  
}
