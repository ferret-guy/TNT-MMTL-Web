
/*
  
  FACILITY:  NMMTL
  
  MODULE DESCRIPTION:
  
  Contains nmmtl_determine_arc_intersectio() which finds where
  dielectric segments and circular conductor segments intersect.
  
  AUTHOR(S):
  
  Kevin J. Buchs
  
  CREATION DATE:  Fri Jan 10 14:35:35 1992
  
  COPYRIGHT:   Copyright (C) 1992 by Mayo Foundation. All rights reserved.
  
  */


/*
 *******************************************************************
 **  INCLUDE FILES
 *******************************************************************
 */

#include "nmmtl.h"

#include <algorithm>
#include <vector>

/*
 * Dielectric interfaces used to be axis aligned, so this module historically
 * edited them by assigning either start/end x or start/end y.  Trapezoid
 * dielectric sides use explicit endpoints instead.  Keep the intersection
 * topology below, but route every endpoint edit and length calculation through
 * these helpers so a segment can have any orientation.
 */
static void nmmtl_arc_die_set_start(DIELECTRIC_SEGMENTS_P seg,
                                    const POINT_P point)
{
  if(seg->orientation == GENERAL_ORIENTATION) {
    seg->x0 = point->x;
    seg->y0 = point->y;
  } else if(seg->orientation == VERTICAL_ORIENTATION) {
    seg->start = point->y;
  } else {
    seg->start = point->x;
  }
}

static void nmmtl_arc_die_set_end(DIELECTRIC_SEGMENTS_P seg,
                                  const POINT_P point)
{
  if(seg->orientation == GENERAL_ORIENTATION) {
    seg->x1 = point->x;
    seg->y1 = point->y;
  } else if(seg->orientation == VERTICAL_ORIENTATION) {
    seg->end = point->y;
  } else {
    seg->end = point->x;
  }
}

static double nmmtl_arc_die_length(const DIELECTRIC_SEGMENTS_P seg)
{
  double x0, y0, x1, y1;
  nmmtl_die_seg_endpoints(seg, &x0, &y0, &x1, &y1);
  return hypot(x1 - x0, y1 - y0);
}

static int nmmtl_arc_points_equal(const POINT_P a, const POINT_P b,
                                  double scale)
{
  double coordinate_scale = fabs(a->x);
  if(fabs(a->y) > coordinate_scale) coordinate_scale = fabs(a->y);
  if(fabs(b->x) > coordinate_scale) coordinate_scale = fabs(b->x);
  if(fabs(b->y) > coordinate_scale) coordinate_scale = fabs(b->y);
  if(scale > coordinate_scale) coordinate_scale = scale;
  if(coordinate_scale < 1.0e-30) coordinate_scale = 1.0e-30;
  const double tolerance = 512.0 * DBL_EPSILON * coordinate_scale;
  return hypot(a->x - b->x, a->y - b->y) <= tolerance;
}

static int nmmtl_arc_cirseg_endpoint(CIRCLE_SEGMENTS_P seg, POINT_P point)
{
  POINT endpoint;
  nmmtl_cirseg_angle_point(seg, seg->startangle,
                           &endpoint.x, &endpoint.y);
  if(nmmtl_arc_points_equal(point, &endpoint, seg->radius))
    return(INITIAL_ENDPOINT);
  nmmtl_cirseg_angle_point(seg, seg->endangle,
                           &endpoint.x, &endpoint.y);
  if(nmmtl_arc_points_equal(point, &endpoint, seg->radius))
    return(TERMINAL_ENDPOINT);
  return(NO_ENDPOINT);
}

/*
 * The legacy arc/interface routine below is a topology state machine written
 * for horizontal and vertical dielectric segments.  Once one genuinely
 * sloped interface is present, process all circle/interface intersections in
 * one analytic pass instead.  This prevents a newly split arc from being fed
 * back through a later interface and avoids zero/infinite arc fragments.
 */
struct NMMTL_GENERAL_CIRCLE
{
  double centerx, centery, radius;
  int divisions, conductor;
};

static const double NMMTL_GENERAL_PARAM_TOL = 1.0e-10;
static const double NMMTL_GENERAL_ANGLE_TOL = 1.0e-10;

static void nmmtl_general_free_circles(CIRCLE_SEGMENTS_P head)
{
  while(head != NULL) {
    CIRCLE_SEGMENTS_P next = head->next;
    free(head);
    head = next;
  }
}

static void nmmtl_general_free_dielectrics(DIELECTRIC_SEGMENTS_P head)
{
  while(head != NULL) {
    DIELECTRIC_SEGMENTS_P next = head->next;
    free(head);
    head = next;
  }
}

static void nmmtl_general_segment_circle_roots(
  double x0, double y0, double x1, double y1,
  const NMMTL_GENERAL_CIRCLE &circle, std::vector<double> *roots)
{
  const double dx = x1 - x0;
  const double dy = y1 - y0;
  const double fx = x0 - circle.centerx;
  const double fy = y0 - circle.centery;
  const double a = dx * dx + dy * dy;
  if(a <= DBL_MIN) return;

  const double b = 2.0 * (fx * dx + fy * dy);
  const double c = fx * fx + fy * fy - circle.radius * circle.radius;
  double discriminant = b * b - 4.0 * a * c;
  const double scale = fabs(b * b) + fabs(4.0 * a * c) +
    a * circle.radius * circle.radius;
  const double discriminant_tolerance =
    1024.0 * DBL_EPSILON * (scale > DBL_MIN ? scale : DBL_MIN);
  if(discriminant < -discriminant_tolerance) return;
  if(fabs(discriminant) <= discriminant_tolerance) discriminant = 0.0;

  const double root = sqrt(discriminant > 0.0 ? discriminant : 0.0);
  double candidates[2];
  int count;
  if(discriminant == 0.0) {
    candidates[0] = -b / (2.0 * a);
    count = 1;
  } else {
    /* q-form avoids losing the near root when |b| ~= sqrt(discriminant). */
    const double q = -0.5 * (b + copysign(root, b));
    if(fabs(q) > DBL_MIN) {
      candidates[0] = q / a;
      candidates[1] = c / q;
    } else {
      candidates[0] = (-b - root) / (2.0 * a);
      candidates[1] = (-b + root) / (2.0 * a);
    }
    count = 2;
  }
  for(int i = 0; i < count; ++i) {
    double t = candidates[i];
    if(t < -NMMTL_GENERAL_PARAM_TOL ||
       t > 1.0 + NMMTL_GENERAL_PARAM_TOL) continue;
    /* Snap endpoint-near roots to the endpoint.  Besides removing numerical
       slivers, this preserves the 0/1 anchors when sorted de-duplication sees
       a root immediately before 1. */
    if(t <= NMMTL_GENERAL_PARAM_TOL) t = 0.0;
    if(t >= 1.0 - NMMTL_GENERAL_PARAM_TOL) t = 1.0;
    roots->push_back(t);
  }
}

static void nmmtl_general_sort_unique(std::vector<double> *values,
                                      double tolerance)
{
  std::sort(values->begin(), values->end());
  std::vector<double> unique;
  unique.reserve(values->size());
  for(std::vector<double>::const_iterator it = values->begin();
      it != values->end(); ++it) {
    if(unique.empty() || fabs(*it - unique.back()) > tolerance)
      unique.push_back(*it);
  }
  values->swap(unique);
}

static double nmmtl_general_angle(double x, double y,
                                  const NMMTL_GENERAL_CIRCLE &circle)
{
  double angle = atan2(y - circle.centery, x - circle.centerx);
  if(angle < 0.0) angle += 2.0 * PI;
  if(angle >= 2.0 * PI - NMMTL_GENERAL_ANGLE_TOL) angle = 0.0;
  return angle;
}

static int nmmtl_general_point_in_dielectric(DIELECTRICS_P dielectric,
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

static float nmmtl_general_point_epsilon(DIELECTRICS_P dielectrics,
                                         double x, double y)
{
  for(DIELECTRICS_P dielectric = dielectrics; dielectric != NULL;
      dielectric = dielectric->next)
    if(nmmtl_general_point_in_dielectric(dielectric, x, y))
      return(dielectric->constant);
  return(AIR_CONSTANT);
}

static int nmmtl_general_point_in_any_circle(
  const std::vector<NMMTL_GENERAL_CIRCLE> &circles, double x, double y)
{
  for(std::vector<NMMTL_GENERAL_CIRCLE>::const_iterator it = circles.begin();
      it != circles.end(); ++it) {
    const double dx = x - it->centerx;
    const double dy = y - it->centery;
    if(dx * dx + dy * dy < it->radius * it->radius) return(TRUE);
  }
  return(FALSE);
}

static int nmmtl_general_arc_clip(CIRCLE_SEGMENTS_P *circle_segments,
                                  DIELECTRIC_SEGMENTS_P *dielectric_segments,
                                  DIELECTRICS_P dielectrics)
{
  std::vector<NMMTL_GENERAL_CIRCLE> circles;
  for(CIRCLE_SEGMENTS_P source = *circle_segments; source != NULL;
      source = source->next) {
    NMMTL_GENERAL_CIRCLE circle;
    circle.centerx = source->centerx;
    circle.centery = source->centery;
    circle.radius = source->radius;
    circle.divisions = source->divisions;
    circle.conductor = source->conductor;
    circles.push_back(circle);
  }

  if(circles.empty()) return(SUCCESS);

  CIRCLE_SEGMENTS_P rebuilt_circles = NULL;
  CIRCLE_SEGMENTS_P circle_tail = NULL;
  for(std::vector<NMMTL_GENERAL_CIRCLE>::const_iterator circle = circles.begin();
      circle != circles.end(); ++circle) {
    std::vector<double> angles;
    angles.push_back(0.0);
    angles.push_back(2.0 * PI);

    for(DIELECTRIC_SEGMENTS_P dielectric = *dielectric_segments;
        dielectric != NULL; dielectric = dielectric->next) {
      /* Linear-conductor clipping already marked this entire remnant for
         removal.  It is not a physical interface for circle intersection. */
      if(dielectric->end_in_conductor != 0) continue;
      double x0, y0, x1, y1;
      nmmtl_die_seg_endpoints(dielectric, &x0, &y0, &x1, &y1);
      std::vector<double> roots;
      nmmtl_general_segment_circle_roots(x0, y0, x1, y1, *circle, &roots);
      for(std::vector<double>::const_iterator root = roots.begin();
          root != roots.end(); ++root) {
        const double x = x0 + *root * (x1 - x0);
        const double y = y0 + *root * (y1 - y0);
        angles.push_back(nmmtl_general_angle(x, y, *circle));
      }
    }
    nmmtl_general_sort_unique(&angles, NMMTL_GENERAL_ANGLE_TOL);

    for(size_t i = 0; i + 1 < angles.size(); ++i) {
      const double span = angles[i + 1] - angles[i];
      if(!(span > NMMTL_GENERAL_ANGLE_TOL) ||
         !(span <= 2.0 * PI + NMMTL_GENERAL_ANGLE_TOL)) continue;

      CIRCLE_SEGMENTS_P arc =
        (CIRCLE_SEGMENTS_P)malloc(sizeof(CIRCLE_SEGMENTS));
      if(arc == NULL) {
        nmmtl_general_free_circles(rebuilt_circles);
        return(FAIL);
      }
      arc->next = NULL;
      arc->centerx = circle->centerx;
      arc->centery = circle->centery;
      arc->radius = circle->radius;
      arc->startangle = angles[i];
      arc->endangle = angles[i + 1];
      arc->radians = span;
      arc->conductor = circle->conductor;
      int divisions = (int)ceil(
        (circle->divisions > 0 ? circle->divisions : 1) *
        span / (2.0 * PI));
      arc->divisions = divisions > 0 ? divisions : 1;

      const double midpoint = 0.5 * (angles[i] + angles[i + 1]);
      const double midpoint_x = circle->centerx +
        circle->radius * cos(midpoint);
      const double midpoint_y = circle->centery +
        circle->radius * sin(midpoint);
      const float epsilon = nmmtl_general_point_epsilon(
        dielectrics, midpoint_x, midpoint_y);
      arc->epsilon[0] = epsilon;
      arc->epsilon[1] = epsilon;

      if(circle_tail == NULL) rebuilt_circles = arc;
      else circle_tail->next = arc;
      circle_tail = arc;
    }
  }

  DIELECTRIC_SEGMENTS_P rebuilt_dielectrics = NULL;
  DIELECTRIC_SEGMENTS_P dielectric_tail = NULL;
  for(DIELECTRIC_SEGMENTS_P source = *dielectric_segments; source != NULL;
      source = source->next) {
    /* Do not resurrect a segment already removed by a line conductor. */
    if(source->end_in_conductor != 0) continue;

    double x0, y0, x1, y1;
    nmmtl_die_seg_endpoints(source, &x0, &y0, &x1, &y1);
    const double dx = x1 - x0;
    const double dy = y1 - y0;
    const double original_length = hypot(dx, dy);
    if(!(original_length > DBL_MIN)) continue;

    std::vector<double> parameters;
    parameters.push_back(0.0);
    parameters.push_back(1.0);
    for(std::vector<NMMTL_GENERAL_CIRCLE>::const_iterator circle = circles.begin();
        circle != circles.end(); ++circle)
      nmmtl_general_segment_circle_roots(x0, y0, x1, y1,
                                         *circle, &parameters);
    nmmtl_general_sort_unique(&parameters, NMMTL_GENERAL_PARAM_TOL);

    for(size_t i = 0; i + 1 < parameters.size(); ++i) {
      const double t0 = parameters[i];
      const double t1 = parameters[i + 1];
      if(!(t1 - t0 > NMMTL_GENERAL_PARAM_TOL)) continue;
      const double midpoint_t = 0.5 * (t0 + t1);
      const double midpoint_x = x0 + midpoint_t * dx;
      const double midpoint_y = y0 + midpoint_t * dy;
      if(nmmtl_general_point_in_any_circle(circles,
                                           midpoint_x, midpoint_y)) continue;

      const double piece_x0 = x0 + t0 * dx;
      const double piece_y0 = y0 + t0 * dy;
      const double piece_x1 = x0 + t1 * dx;
      const double piece_y1 = y0 + t1 * dy;
      const double piece_length = hypot(piece_x1 - piece_x0,
                                        piece_y1 - piece_y0);
      if(!(piece_length > DBL_MIN)) continue;

      DIELECTRIC_SEGMENTS_P piece =
        (DIELECTRIC_SEGMENTS_P)malloc(sizeof(DIELECTRIC_SEGMENTS));
      if(piece == NULL) {
        nmmtl_general_free_circles(rebuilt_circles);
        nmmtl_general_free_dielectrics(rebuilt_dielectrics);
        return(FAIL);
      }
      *piece = *source;
      piece->next = NULL;
      piece->end_in_conductor = 0;
      nmmtl_die_seg_set_explicit(piece,
                                 piece_x0, piece_y0,
                                 piece_x1, piece_y1);
      if(piece->orientation == GENERAL_ORIENTATION) {
        piece->at = piece->start = piece->end = 0.0;
      } else if(piece->orientation == VERTICAL_ORIENTATION) {
        piece->at = 0.5 * (piece_x0 + piece_x1);
        piece->start = piece_y0;
        piece->end = piece_y1;
      } else {
        piece->at = 0.5 * (piece_y0 + piece_y1);
        piece->start = piece_x0;
        piece->end = piece_x1;
      }
      piece->length = piece_length;
      int divisions = (int)ceil(
        (source->divisions > 0 ? source->divisions : 1) *
        piece_length / original_length);
      piece->divisions = divisions > 0 ? divisions : 1;

      if(dielectric_tail == NULL) rebuilt_dielectrics = piece;
      else dielectric_tail->next = piece;
      dielectric_tail = piece;
    }
  }

  nmmtl_general_free_circles(*circle_segments);
  nmmtl_general_free_dielectrics(*dielectric_segments);
  *circle_segments = rebuilt_circles;
  *dielectric_segments = rebuilt_dielectrics;
  return(SUCCESS);
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

/* classifications of intersection points */

#define IP_I1D0 1   /* intersection 1 hit on initial point of dielectric seg */
#define IP_I1D1 2
#define IP_I2D0 4
#define IP_I2D1 8
#define IP_I1C0 16  /* intersection 1 hit on initial point of conductor arc */
#define IP_I1C1 32
#define IP_I2C0 64
#define IP_I2C1 128



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
  
  FUNCTION NAME:  nmmtl_determine_arc_intersectio
  
  
  FUNCTIONAL DESCRIPTION:
  
  Find the intersections between dielectric-dielectric interface
  segments and conductor circular segments.  Also see
  nmmtl_determine_intersections.c which does the same thing for
  linear conductor segments.  This determination of intersections will
  result in the following operations upon these segments: fracturing of
  both types of segments into pairs of smaller segments with different
  properties, reducing the size of segments, setting epsilon and
  theta1/nu properties for conductor segments..
  
  How many different kinds of circle-segment line-segment intersections
  can we think of?
  
  ============================================================================
  Legend
  ============================================================================
  
  c                                d
  c			      d
  c			      d
  c			      d
  c			      d
  c			      d
  c			      d
  c			      d
  c			      d
  c                  	      d
  
  This is a circular segment           This is a line segment of a
  of a conductor                       dielectric-dielectric interface
  
  
  c
  dddxddd
  c
  
  X is the intersection point.
  
  ============================================================================
  Types of intersections
  ============================================================================
  
  
  ==============================================================================
  
  d                      1) Endpoint of circle
  d
  d  	       	      Actions:
  x
  d    c	       	      set epsilon for conductor
  d       c	       	      dielectric is fractured
  d         c	       	      
  d           c
  c
  c
  c
  c
  c
  
  ==============================================================================
  
  d
  d
  d
  d                       2) Endpoints of both die and
  x                        conductor, die outside circle
  c
  c                   Actions: set epsilon for conductor
  c
  c
  c
  c
  c
  c
  c
  
  ==============================================================================
  
  x
  d   c
  d      c
  d        c                  3) Endpoints of both, die inside
  d          c
  c                 Actions: set end_in_conductor for die
  c
  c
  c
  c
  
  ==============================================================================
  
  c
  c
  c
  c                  4) Die endpoint on radius, die inside
  c
  ddddddddx                 Actions: set end_in_conductor for die
  c
  c
  c
  c
  
  ==============================================================================
  
  c
  c                     5) Die endpoint on radius, die outside
  c
  c                  Actions:
  c
  xdddddddddd       fracture circle segment, set epsilon
  c                  for each half.
  c
  c
  c
  
  ==============================================================================
  
  c
  c
  c                   6) Die passes through radius
  c
  c                 Actions:
  dddddddxdddddd
  c                  fracture die and set
  c                   end_in_conductor for die inside
  c                     fracture circle and set epsilons
  c
  
  ==============================================================================
  
  c    d
  c d
  x                   7) Chordal
  dc
  d c                 Actions:
  d c
  dc                  fracture conductor into 3 parts, set
  x                   epsilons.
  c d
  c    d                   middle part of die removed.  New piece
  created.
  ==============================================================================
  
  c    d
  c d
  x                   8) Chordal terminating
  dc
  d c                 Actions:
  d c
  dc                  fracture conductor into 2 parts, set
  x                   epsilons.
  c
  c                        interior part of die removed.
  
  ==============================================================================
  
  c
  c
  x                   9) Chordal bi-terminating
  dc
  d c                 Actions: die removed.
  d c
  dc
  x
  c
  c
  
  ==============================================================================
  
  c      d
  c   d
  c d
  cd                 10) Tangential plain
  x
  x                 Actions: Do nothing
  cd
  c d
  c   d
  c      d
  
  ==============================================================================
  
  c
  c
  c
  c
  c                 11) Tangential terminating
  x
  cd                 Actions: Do nothing
  c d
  c   d
  c      d
  d
  
  ==============================================================================
  
  c
  c
  c
  c                  12) Tangential terminating at endpoints,
  c                 die outside
  c
  c                  Actions: set epsilon on conductor
  c
  c
  xddddddddddddd
  
  ==============================================================================
  
  c
  c
  c
  c                  13) Tangential terminating at endpoint
  c                 die both sides
  c
  c                  Actions: set epsilon on conductor
  c
  c
  ddddddxdddddddd
  
  ==============================================================================
  
  c
  c
  c
  c                  14) Tangential terminating at endpoints,
  c                 die "inside"
  c
  c                  Actions: Nothing
  c
  c
  ddddddx
  
  ==============================================================================
  
  d
  d
  d
  x
  d  c
  d    c                   15) Chordal on conductor endpoints
  d     c
  d      c                 Actions:
  d      c
  d     c                  set epsilons.
  d    c
  d  c
  x                        middle part of die removed.  New piece
  d                        created.
  d
  d
  
  ==============================================================================
  
  
  
  
  x
  d  c
  d    c                   16) Chordal on conductor endpoints
  d     c                      and one die endpoint
  d      c                 Actions:
  d      c
  d     c                  set epsilons.
  d    c
  d  c
  x                        middle part of die removed.  Shrink
  d                        leftover.
  d
  d
  
  ==============================================================================
  
  
  x
  d  c
  d    c                   17) Chordal on conductor endpoints
  d     c                      and both die endpoints
  d      c
  d      c                 Actions: die removed
  d     c
  d    c
  d  c
  x
  
  
  ==============================================================================
  
  d
  d
  x
  d c
  d  c                   18) Chordal on one conductor endpoint
  d  c                      and no die endpoints
  d  c
  d c                 Actions:
  x
  c d                 die piece added, original shrunk to
  c    d                remove middle section
  c        d
  d              fracture circle segment, 
  epsilon values set
  ==============================================================================
  
  d
  d
  x
  d c
  d  c                   19) Chordal on one conductor endpoint
  d  c                      and one die endpoint
  d  c
  d c                 Actions: die removed by shrinking
  x                     the original 
  c 
  c                     Epsilon set.
  c        
  
  
  ==============================================================================
  
  x
  d c
  d  c                   20) Chordal on conductor endpoints
  d  c                      and both die endpoints
  d  c
  d c                 Actions: die removed                  
  x
  c
  c  
  c        
  
  
  ==============================================================================
  
  x
  d c                     21) Chordal intersection on one 
  d  c                       conductor endpoint and different
  d  c                      intersection on one die endpoint
  d  c		      Actions:                             
  d c                                                      
  x		      die removed by shrinking the original
  c d		                                           
  c    d		      fracture circle segment,
  c        d               epsilon values set
  
  ==============================================================================
  
  The dielectric and conductor segments have a 0th and 1st endpoints.  The
  are given by the order they are listed.
  
  We have these constants to define where an intersection occurred:
  
  I1D0       intersection1 is on dielectric endpoint 0
  I2D0       intersection2 is on dielectric endpoint 0
  I1D1       intersection1 is on dielectric endpoint 1
  I2D1       intersection2 is on dielectric endpoint 1
  I1C0       intersection1 is on conductor endpoint 0
  I2C0       intersection2 is on conductor endpoint 0
  I1C1       intersection1 is on conductor endpoint 1
  I2C1       intersection2 is on conductor endpoint 1
  
  The variable it is defined to be each of these in a unique bit position.
  
  Of the above types of intersections, these will be the possible combinations,
  where ? = (0,1) :
  
  1)   I?C?
  2)   I?C? and I?D?
  3)   I?C? and I?D?
  4)   I?D?
  5)   I?D?
  6)   none
  7)   none
  8)   I?D? (one)
  9)   I?D0 and I?D1 (two)
  10)   none
  11)  I?D?
  12)  I?C? and I?D?
  13)  I?C?
  14)  I?C? and I?D?
  15)  I?C0 and I?C1
  16)  I?C0, I?C1, and I?D?
  17)  I?C0, I?C1, I?D0, and I?D1
  18)  I?C?
  19)  I?C? and I?D?
  20)  I?C?, I?D0, and I?D1
  21)  (I1C? and I2D?) or (I2C? and I1D?)
  
  Distingushing features:
  
  One Intersection:
  
  1) and 13) :
  13) is tangential
  2), 3), 12), and 14) :
  2) piece of die has less than 90 degree angle to normal
  3) piece of die has greater than 90 degree angle to normal
  12) tangential - die outside
  14) tangential - die inside
  4), 5), and 11) :
  4) piece of die has greater than 90 degree angle to normal
  5) piece of die has less than 90 degree angle to normal
  11) tangential
  6), and 10) :
  6) single intersection
  10) tangential
  
  Two Intersections:
  
  7)  0  conductor and 0  die endpoint hits
  8)  0  conductor and 1 die endpoint hits
  9)  0  conductor and 2 die endpoint hits
  15) 2 conductor and 0  die endpoint hits
  16) 2 conductor and 1  die endpoint hits
  17) 2 conductor and 2 die endpoint hits
  18) 1 conductor and 0 die endpoint hits
  19) 1 conductor and 1 die endpoint hits - same intersections
  20) 1 conductor and 2 die endpoint hits
  21) 1 conductor and 1 die endpoint hits - opposite intersections
  
  Tagentiality is determined by the angle with the intersection routine, which
  returns a flag.  Angle with the normal is easy to get, the normal is the line
  segment from the center of the arc to the intesection point.
  
  For 12), and 14), we need to determine if the die is "inside" or
  "outside".  For 13) we want to know which piece is inside.  Really,
  all is outside, since it what we have is a tangent line.  However, if
  you drew a normal at the intersection point, "inside is the opposide
  direction from the direction the arc goes away from the normal.  The
  algorithm is:
  
  if at initial point of arc and left turn (+90 degrees) to the die from
  normal, then it is outside.
  
  if at terminal point of arc and right turn (-90) to the die from
  normal, then it is outside.
  
  
  FORMAL PARAMETERS:
  
  CIRCLE_SEGMENTS_P *circle_segments,     The list of circle segments
  DIELECTRIC_SEGMENTS_P *dielectric_segments  The list of dielectric segments
  
  RETURN VALUE:
  
  SUCCESS or FAIL
  
  CALLING SEQUENCE:
  
  status = nmmtl_determine_intersectio(&circle_segments,&dielectric_segments
  );
  
  */

int nmmtl_determine_arc_intersectio(CIRCLE_SEGMENTS_P *circle_segments,
				    DIELECTRIC_SEGMENTS_P *dielectric_segments,
				    DIELECTRICS_P dielectrics)
{
  for(DIELECTRIC_SEGMENTS_P candidate = *dielectric_segments;
      candidate != NULL; candidate = candidate->next)
    if(candidate->orientation == GENERAL_ORIENTATION)
      return(nmmtl_general_arc_clip(circle_segments,
					    dielectric_segments,
					    dielectrics));

  LINESEG dseg;
  POINT intersection1,intersection2;
  int number_of_intersections,tangent;
  CIRCLE_SEGMENTS_P segment, last_segment, new_cs, new_cs_2;
  DIELECTRIC_SEGMENTS_P dieseg, last_dieseg, new_ds = NULL;
  double intersection_angle,inter_angle[2];
  long int ip;  /* intersection points - recordkeeping flag for IP_* */
  int vert_die; /* flags indicating that these are vertical
		   segments, i.e. slope in infinite */
  int die_inc_dir; /* TRUE or FALSE - conductor or dielectric
		      is in increasing direction */
  int cirseg_endpoint; /* indicates if an intersection is on an endpoint of
			  the circle segment. */
  int cseg_index,dseg_index; /* initial or terminal points */
  double angle_to_normal;
  int intersection_type; /* just a serially numbered type of intersection -
			    see the above documentation */
  int cond_hits,die_hits; /* number of intersections that are on endpoints */
  
  int break_out_of_conductor_loop = FALSE;
  
  /* Now detemine the intersections of conductor circle segments with
     dielectric-dielectric segments.
     
     Since there is some copying of data for each dielectric segment,
     move ta loop to the outside to avoid repeating that work
     */
  
  dieseg = *dielectric_segments;
  last_dieseg = NULL;
  
  while(dieseg != NULL)
  {
    nmmtl_die_seg_endpoints(dieseg,
                            &dseg.x[0], &dseg.y[0],
                            &dseg.x[1], &dseg.y[1]);
    vert_die = fabs(dseg.x[1] - dseg.x[0]) <
      fabs(dseg.y[1] - dseg.y[0]);
    if(vert_die) die_inc_dir = dseg.y[1] > dseg.y[0];
    else die_inc_dir = dseg.x[1] > dseg.x[0];
    segment = *circle_segments;
    break_out_of_conductor_loop = FALSE;
    while(segment != NULL && break_out_of_conductor_loop == FALSE)
    {
      /* determine if the dieseg was adjusted within the loop and hence,
	 dseg needs to be recomputed */
      if(new_ds != NULL)
      {
	new_ds = NULL;
	
	nmmtl_die_seg_endpoints(dieseg,
				&dseg.x[0], &dseg.y[0],
				&dseg.x[1], &dseg.y[1]);
	vert_die = fabs(dseg.x[1] - dseg.x[0]) <
	  fabs(dseg.y[1] - dseg.y[0]);
	if(vert_die) die_inc_dir = dseg.y[1] > dseg.y[0];
	else die_inc_dir = dseg.x[1] > dseg.x[0];
      }
      
      number_of_intersections = nmmtl_cirseg_seg_inter(segment,&dseg,
						       &intersection1,
						       &intersection2,
						       &tangent);
      if(number_of_intersections > 0)
      {
	
	/* classify the intersection points */
	
	ip = 0;
	cond_hits = 0;
	die_hits = 0;
	
	{
	  POINT endpoint;
	  const double endpoint_scale = segment->radius + dieseg->length;
	  endpoint.x = dseg.x[0]; endpoint.y = dseg.y[0];
	  if(nmmtl_arc_points_equal(&intersection1, &endpoint, endpoint_scale))
	{
	  ip |= IP_I1D0;
	  die_hits++;
	}
	  endpoint.x = dseg.x[1]; endpoint.y = dseg.y[1];
	  if(nmmtl_arc_points_equal(&intersection1, &endpoint, endpoint_scale))
	{
	  ip |= IP_I1D1;
	  die_hits++;
	}
	}
	 cirseg_endpoint = nmmtl_arc_cirseg_endpoint(segment,&intersection1);
	if(cirseg_endpoint == INITIAL_ENDPOINT)
	{
	  ip |= IP_I1C0;
	  cond_hits++;
	}
	if(cirseg_endpoint == TERMINAL_ENDPOINT)
	{
	  ip |= IP_I1C1;
	  cond_hits++;
	}
	if(number_of_intersections == 2)
	{
	  {
	    POINT endpoint;
	    const double endpoint_scale = segment->radius + dieseg->length;
	    endpoint.x = dseg.x[0]; endpoint.y = dseg.y[0];
	    if(nmmtl_arc_points_equal(&intersection2, &endpoint, endpoint_scale))
	  {
	    ip |= IP_I2D0;
	    die_hits++;
	  }
	    endpoint.x = dseg.x[1]; endpoint.y = dseg.y[1];
	    if(nmmtl_arc_points_equal(&intersection2, &endpoint, endpoint_scale))
	  {
	    ip |= IP_I2D1;
	    die_hits++;
	  }
	  }
	  cirseg_endpoint = nmmtl_arc_cirseg_endpoint(segment,&intersection2);
	  if(cirseg_endpoint == INITIAL_ENDPOINT)
	  {
	    ip |= IP_I2C0;
	    cond_hits++;
	  }
	  if(cirseg_endpoint == TERMINAL_ENDPOINT)
	  {
	    ip |= IP_I2C1;
	    cond_hits++;
	  }
	}
	
	/* Now divide things up further */
	
	if(number_of_intersections == 1)
	{
	  /* one intersection */
	  
	  if(ip & IP_I1D0) dseg_index = INITIAL_ENDPOINT;
	  else dseg_index = TERMINAL_ENDPOINT;
	  if(ip & IP_I1C0) cseg_index = INITIAL_ENDPOINT;
	  else cseg_index = TERMINAL_ENDPOINT;
	  
	  if(ip & (IP_I1C0 | IP_I1C1))
	  {
	    /* hit one conductor endpoint */
	    
	    if(ip & (IP_I1D0 | IP_I1D1))
	    {
	      /* hit one dielectric endpoint */
	      angle_to_normal =
		nmmtl_cirseg_angle_to_normal(segment,&intersection1,
					     &dseg,dseg_index);
	      if(tangent)
	      {
		if(angle_to_normal > 0.0 && cseg_index == INITIAL_ENDPOINT ||
		   angle_to_normal < 0.0 && cseg_index == TERMINAL_ENDPOINT)
		  intersection_type = 14;
		else
		  intersection_type = 12;
	      }
	      else
	      {
		if(fabs(angle_to_normal) < PI/2)
		  intersection_type = 2;
		else
		  intersection_type = 3;
	      }
	    } /* one die hit */
	    else
	    {
	      /* no die hit, one cond hit */
	      if(tangent) intersection_type = 13;
	      else intersection_type = 1;
	    }                      /* no die hit, one cond hit */
	  }                        /* one cond hit */
	  else
	  {
	    /* no cond hit */
	    if(ip & (IP_I1D0 | IP_I1D1))
	    {
	      /* die hit */
	      angle_to_normal =
		nmmtl_cirseg_angle_to_normal(segment,&intersection1,
					     &dseg,dseg_index);
	      if(tangent)
	      {
		intersection_type = 11;
	      }
	      else
	      {
		if(fabs(angle_to_normal) < PI/2)
		  intersection_type = 5;
		else
		  intersection_type = 4;
	      }
	    } /* one die hit */
	    else
	    {
	      /* no die hit, no cond hit */
	      if(tangent) intersection_type = 10;
	      else intersection_type = 6;
	      
	    }                      /* no die hit, one cond hit */
	  }                        /* no cond hit */
	}                          /* one intersection */
	else
	{
	  /* two intersections */
	  switch(cond_hits)
	  {
	  case 0:
	    switch(die_hits)
	    {
	    case 0: intersection_type = 7; break; 
	    case 1: intersection_type = 8; break; 
	    case 2: intersection_type = 9; break; 
	    }
	    break;
	  case 1:
	    switch(die_hits)
	    {
	    case 0: intersection_type = 18; break; 
	    case 1: 
	      /* are conductor and die endpoint intersections different or
		 the same intersection ? */
	      if(ip & (IP_I1C0 | IP_I1C1) && ip & (IP_I2D0 | IP_I2D1) ||
		 ip & (IP_I2C0 | IP_I2C1) && ip & (IP_I1D0 | IP_I1D1))
		intersection_type = 19;     /* different endpoint */
	      else intersection_type = 21;  /* same endpoint */
	      break; 
	    case 2: intersection_type = 20; break; 
	    }
	    break;
	  case 2:
	    switch(die_hits)
	    {
	    case 0: intersection_type = 15; break; 
	    case 1: intersection_type = 16; break; 
	    case 2: intersection_type = 17; break; 
	    }
	    break;
	  }
	}                          /* two intersections */
	
	/* Now that we have fully determined the intersection type, take
	   the appropriate action based on that type. */
	
	switch(intersection_type)
	{
	case 1 :
	  /*
	    Endpoint of circle                 
	    
	    Actions:                              
	    
	    set epsilon for conductor
	    dielectric is fractured
	    
	    */
	  
	  
	  /* Create new dielectric segment by splitting the old one. */
	  new_ds = 
	    (DIELECTRIC_SEGMENTS_P)malloc(sizeof(DIELECTRIC_SEGMENTS));
	  *new_ds = *dieseg;
	  new_ds->next = dieseg->next;
	  dieseg->next = new_ds;
	  new_ds->at = dieseg->at;
	  new_ds->end = dieseg->end;
	  new_ds->epsilonplus = dieseg->epsilonplus;
	  new_ds->epsilonminus = dieseg->epsilonminus;
	  new_ds->segment_number = dieseg->segment_number;
	  new_ds->end_in_conductor = dieseg->end_in_conductor;
	  new_ds->orientation = dieseg->orientation;
	  
	  nmmtl_arc_die_set_start(new_ds, &intersection1);
	  nmmtl_arc_die_set_end(dieseg, &intersection1);
	  
	  new_ds->length = nmmtl_arc_die_length(new_ds);
	  new_ds->divisions = (int)(dieseg->divisions * 
	    (new_ds->length/dieseg->length) + 1.0);
	  dieseg->length -= new_ds->length;
	  dieseg->divisions -= (new_ds->divisions - 1);
	  
	  /* which end of die is inside ? */
	  angle_to_normal =
	    nmmtl_cirseg_angle_to_normal(segment,&intersection1,&dseg,0);
	  if(fabs(angle_to_normal) < PI/2)
	  {
	    /* intersection to initial endpoint is inside */
	    dieseg->end_in_conductor |= 0X02;  /* set bit 2 */
	    new_ds->end_in_conductor &= 0XFFFFFFFE;  /* clear bit 1 */
	    
	    if( ip & IP_I1C0 )
	      segment->epsilon[0] = dieseg->epsilonplus;
	    else
	      segment->epsilon[1] = dieseg->epsilonminus;
	  }
	  else
	  {
	    /* intersection to initial endpoint is outside */
	    dieseg->end_in_conductor &= 0XFFFFFFFD;  /* clear bit 2 */
	    new_ds->end_in_conductor |= 0X01;  /* set bit 1 */
	    
	    if( ip & IP_I1C0 )
	      segment->epsilon[0] = dieseg->epsilonminus;
	    else
	      segment->epsilon[1] = dieseg->epsilonplus;
	  }
	  
	  break;
	  
	case 2 :
	  /*
	    Endpoints of both die and          
	    conductor, die outside circle         
	    
	    Actions: set epsilon for conductor    
	    */
	  /* find the appropriate epsilon */
	  if(ip & IP_I1D0)
	  {
	    /* intersection is with initial endpoint of die */
	    if( ip & IP_I1C0 )
	    {
	      segment->epsilon[0] = dieseg->epsilonplus;
	    }
	    else
	    {
	      segment->epsilon[1] = dieseg->epsilonminus;
	    }
	  }
	  else
	  {
	    /* intersection is with terminal endpoint of die */
	    if( ip & IP_I1C0 )
	    {
	      segment->epsilon[0] = dieseg->epsilonminus;
	    }
	    else
	    {
	      segment->epsilon[1] = dieseg->epsilonplus;
	    }
	  }
	  
	  
	  break;
	  
	case 3 :
	  /*
	    Endpoints of both, die inside      
	    
	    Actions: set end_in_conductor for die                   
	    */
	  
	  /* which end of die is inside ? */
	  if(ip & IP_I1D0)
	  {
	    /* initial endpoint is on conductor */
	    dieseg->end_in_conductor |= 0X01;  /* set bit 1 */
	  }
	  else
	  {
	    /* terminal endpoint is on conductor */
	    dieseg->end_in_conductor |= 0X02;  /* set bit 2 */
	  }
	  
	  break;
	  
	case 4 :
	  
	  /*
	    Die endpoint on radius, die inside 
	    
	    Actions: set end_in_conductor for die
	    */
	  
	  /* which end of die is inside ? */
	  if(ip & IP_I1D0)
	  {
	    /* initial endpoint is on conductor */
	    dieseg->end_in_conductor |= 0X01;  /* set bit 1 */
	  }
	  else
	  {
	    /* terminal endpoint is on conductor */
	    dieseg->end_in_conductor |= 0X02;  /* set bit 2 */
	  }
	  
	  break;
	  
	case 5 :
	  /*
	    Die endpoint on radius, die outside
	    
	    Actions:                              
	    
	    fracture circle segment, set epsilon  
	    for each half.                        
	    */
	  
	  /* create new conductor circle segment */
	  new_cs = (CIRCLE_SEGMENTS_P) malloc(sizeof(CIRCLE_SEGMENTS));
	  new_cs->centerx = segment->centerx;
	  new_cs->centery = segment->centery;
	  new_cs->radius = segment->radius;
	  new_cs->conductor = segment->conductor;
	  new_cs->endangle = segment->endangle;
	  new_cs->epsilon[1] = segment->epsilon[1];
	  
	  /* find the angle of the intersection */
	  intersection_angle =
	    nmmtl_cirseg_point_angle(segment,intersection1.x,intersection1.y);
	  /* set up the coordinates */
	  segment->endangle = intersection_angle;
	  new_cs->startangle = intersection_angle;
	  new_cs->radians = new_cs->endangle - new_cs->startangle;
	  new_cs->divisions = (int)(segment->divisions *
	    (new_cs->radians / segment->radians) + 1.0);
	  segment->divisions += 1 - new_cs->divisions;
	  segment->radians -= new_cs->radians;
	  /* hook into the list */
	  new_cs->next = segment->next;
	  segment->next = new_cs;
	  
	  if(ip & IP_I1D0)
	  {
	    /* intersection at initial point of die */
	    new_cs->epsilon[0] = dieseg->epsilonplus;
	    segment->epsilon[1] = dieseg->epsilonminus;
	  }
	  else
	  {
	    /* intersection at terminal point of die */
	    new_cs->epsilon[0] = dieseg->epsilonminus;
	    segment->epsilon[1] = dieseg->epsilonplus;
	  }
	  
	  break;
	  
	case 6 :
	  /*
	    Die passes through radius          
	    
	    Actions:                              
	    
	    fracture die and set
	    end_in_conductor for die inside
	    
	    fracture circle and set epsilons      
	    */
	  
	  /* Create new dielectric segment by splitting the old one. */
	  new_ds = 
	    (DIELECTRIC_SEGMENTS_P)malloc(sizeof(DIELECTRIC_SEGMENTS));
	  *new_ds = *dieseg;
	  new_ds->next = dieseg->next;
	  dieseg->next = new_ds;
	  new_ds->at = dieseg->at;
	  new_ds->end = dieseg->end;
	  new_ds->epsilonplus = dieseg->epsilonplus;
	  new_ds->epsilonminus = dieseg->epsilonminus;
	  new_ds->segment_number = dieseg->segment_number;
	  new_ds->end_in_conductor = dieseg->end_in_conductor;
	  new_ds->orientation = dieseg->orientation;
	  
	  nmmtl_arc_die_set_start(new_ds, &intersection1);
	  nmmtl_arc_die_set_end(dieseg, &intersection1);
	  
	  new_ds->length = nmmtl_arc_die_length(new_ds);
	  new_ds->divisions = (int)(dieseg->divisions * 
	    (new_ds->length/dieseg->length) + 1.0);
	  dieseg->length -= new_ds->length;
	  dieseg->divisions -= (new_ds->divisions - 1);
	  
	  /* create new conductor circle segment */
	  new_cs = (CIRCLE_SEGMENTS_P) malloc(sizeof(CIRCLE_SEGMENTS));
	  new_cs->centerx = segment->centerx;
	  new_cs->centery = segment->centery;
	  new_cs->radius = segment->radius;
	  new_cs->conductor = segment->conductor;
	  new_cs->endangle = segment->endangle;
	  new_cs->epsilon[1] = segment->epsilon[1];
	  
	  /* find the angle of the intersection */
	  intersection_angle =
	    nmmtl_cirseg_point_angle(segment,intersection1.x,intersection1.y);
	  /* set up the coordinates */
	  segment->endangle = intersection_angle;
	  new_cs->startangle = intersection_angle;
	  new_cs->radians = new_cs->endangle - new_cs->startangle;
	  new_cs->divisions = (int)(segment->divisions *
	    (new_cs->radians / segment->radians) + 1.0);
	  segment->divisions += 1 - new_cs->divisions;
	  segment->radians -= new_cs->radians;
	  /* hook into the list */
	  new_cs->next = segment->next;
	  segment->next = new_cs;
	  
	  /* which end of die is inside ? */
	  angle_to_normal =
	    nmmtl_cirseg_angle_to_normal(segment,&intersection1,&dseg,0);
	  if(fabs(angle_to_normal) < PI/2)
	  {
	    /* intersection to initial endpoint is inside */
	    /* set appropriate epsilon values */
	    new_cs->epsilon[0] = dieseg->epsilonplus;
	    segment->epsilon[1] = dieseg->epsilonminus;
	    
	    dieseg->end_in_conductor |= 0X02;  /* set bit 2 */
	    new_ds->end_in_conductor &= 0XFFFFFFFE;  /* clear bit 1 */
	  }
	  else
	  {
	    /* intersection to initial endpoint is outside */
	    /* set appropriate epsilon values */
	    new_cs->epsilon[0] = dieseg->epsilonminus;
	    segment->epsilon[1] = dieseg->epsilonplus;
	    
	    dieseg->end_in_conductor &= 0XFFFFFFFD;  /* clear bit 2 */
	    new_ds->end_in_conductor |= 0X01;  /* set bit 1 */
	  }
	  
	  break;
	  
	case 7 :
	  /*
	    Chordal                            
	    
	    Actions:                              
	    
	    fracture conductor into 3 parts, set  
	    epsilons.                             
	    
	    middle part of die removed.  New piece
	    created.                              
	    */
	  
	  /* create two new conductor circle segments */
	  new_cs = (CIRCLE_SEGMENTS_P) malloc(sizeof(CIRCLE_SEGMENTS));
	  new_cs->centerx = segment->centerx;
	  new_cs->centery = segment->centery;
	  new_cs->radius = segment->radius;
	  new_cs->conductor = segment->conductor;
	  new_cs_2 = (CIRCLE_SEGMENTS_P) malloc(sizeof(CIRCLE_SEGMENTS));
	  new_cs_2->centerx = segment->centerx;
	  new_cs_2->centery = segment->centery;
	  new_cs_2->radius = segment->radius;
	  new_cs_2->conductor = segment->conductor;
	  /* hook into the list */
	  new_cs_2->next = segment->next;
	  new_cs->next = new_cs_2;
	  segment->next = new_cs;
	  new_cs_2->endangle = segment->endangle;
	  new_cs_2->epsilon[1] = segment->epsilon[1];
	  
	  /* Create new dielectric segment by splitting the old one. */
	  new_ds = 
	    (DIELECTRIC_SEGMENTS_P)malloc(sizeof(DIELECTRIC_SEGMENTS));
	  *new_ds = *dieseg;
	  new_ds->next = dieseg->next;
	  dieseg->next = new_ds;
	  new_ds->at = dieseg->at;
	  new_ds->end = dieseg->end;
	  
	  new_ds->epsilonplus = dieseg->epsilonplus;
	  new_ds->epsilonminus = dieseg->epsilonminus;
	  new_ds->segment_number = dieseg->segment_number;
	  new_ds->end_in_conductor = dieseg->end_in_conductor;
	  new_ds->orientation = dieseg->orientation;
	  /* neither ends in a conductor - so clear the bits */
	  dieseg->end_in_conductor &= 0XFFFD;  /* clear bit 2 */
	  new_ds->end_in_conductor &= 0XFFFE;  /* clear bit 1 */
	  
	  /* find which intersection comes first on circle segment */
	  
	  /* find the angles of the intersections */
	  inter_angle[0] = 
	    nmmtl_cirseg_point_angle(segment,intersection1.x,intersection1.y);
	  inter_angle[1] =
	    nmmtl_cirseg_point_angle(segment,intersection2.x,intersection2.y);
	  
	  if(inter_angle[0] < inter_angle[1])
	  {
	    /* intersection1 is first */
	    
	    /* set up the coordinates */
	    segment->endangle = inter_angle[0];
	    new_cs->startangle = inter_angle[0];
	    new_cs->endangle = inter_angle[1];
	    new_cs->radians = new_cs->endangle - new_cs->startangle;
	    new_cs->divisions = (int)(segment->divisions *
	      (new_cs->radians / segment->radians) + 1.0);
	    new_cs_2->startangle = inter_angle[1];
	    new_cs_2->radians = new_cs_2->endangle - new_cs_2->startangle;
	    new_cs_2->divisions = (int)(segment->divisions *
	      (new_cs_2->radians / segment->radians) + 1.0);
	    segment->divisions = (int)(1.0 + segment->divisions *
	      (1 - (new_cs->radians + new_cs_2->radians)/segment->radians));
	    segment->radians -= new_cs->radians + new_cs_2->radians;
	    
	    /* which end of die goes inside ? */
	    angle_to_normal =
	      nmmtl_cirseg_angle_to_normal(segment,&intersection1,&dseg,0);
	    if(fabs(angle_to_normal) < PI/2)
	    {
	      /* from intersection1, initial end of die is inside conductor */
	      segment->epsilon[1] = dieseg->epsilonminus;
	      new_cs_2->epsilon[0] = dieseg->epsilonminus;
	      new_cs->epsilon[0] = dieseg->epsilonplus;
	      new_cs->epsilon[1] = dieseg->epsilonplus;
	      nmmtl_arc_die_set_start(new_ds, &intersection1);
	      nmmtl_arc_die_set_end(dieseg, &intersection2);
	      
	    }
	    else
	    {
	      /* from intersection1, initial end of die is outside conductor */
	      segment->epsilon[1] = dieseg->epsilonplus;
	      new_cs_2->epsilon[0] = dieseg->epsilonplus;
	      new_cs->epsilon[0] = dieseg->epsilonminus;
	      new_cs->epsilon[1] = dieseg->epsilonminus;
	      nmmtl_arc_die_set_start(new_ds, &intersection2);
	      nmmtl_arc_die_set_end(dieseg, &intersection1);
	    }
	  }
	  else
	  {
	    /* intersection2 is first */
	    
	    /* set up the coordinates */
	    segment->endangle = inter_angle[1];
	    new_cs->startangle = inter_angle[1];
	    new_cs->endangle = inter_angle[0];
	    new_cs->radians = new_cs->endangle - new_cs->startangle;
	    new_cs->divisions = (int)(segment->divisions *
	      (new_cs->radians / segment->radians) + 1.0);
	    new_cs_2->startangle = inter_angle[0];
	    new_cs_2->radians = new_cs_2->endangle - new_cs_2->startangle;
	    new_cs_2->divisions = (int)(segment->divisions *
	      (new_cs_2->radians / segment->radians) + 1.0);
	    segment->divisions = (int)(1.0 + segment->divisions *
	      (1 - (new_cs->radians + new_cs_2->radians)/segment->radians));
	    segment->radians -= new_cs->radians + new_cs_2->radians;
	    
	    /* which end of die goes inside ? */
	    angle_to_normal =
	      nmmtl_cirseg_angle_to_normal(segment,&intersection2,&dseg,0);
	    if(fabs(angle_to_normal) < PI/2)
	    {
	      /* from intersection2, initial end of die is inside conductor */
	      segment->epsilon[1] = dieseg->epsilonminus;
	      new_cs_2->epsilon[0] = dieseg->epsilonminus;
	      new_cs->epsilon[0] = dieseg->epsilonplus;
	      new_cs->epsilon[1] = dieseg->epsilonplus;
	      nmmtl_arc_die_set_start(new_ds, &intersection2);
	      nmmtl_arc_die_set_end(dieseg, &intersection1);
	      
	    }
	    else
	    {
	      /* from intersection1, initial end of die is outside conductor */
	      segment->epsilon[1] = dieseg->epsilonplus;
	      new_cs_2->epsilon[0] = dieseg->epsilonplus;
	      new_cs->epsilon[0] = dieseg->epsilonminus;
	      new_cs->epsilon[1] = dieseg->epsilonminus;
	      nmmtl_arc_die_set_start(new_ds, &intersection1);
	      nmmtl_arc_die_set_end(dieseg, &intersection2);
	    }
	  }
	  
	  
	  /* finally, compute the redistribution of divisions based on
	     length */
	  new_ds->length = nmmtl_arc_die_length(new_ds);
	  new_ds->divisions = (int)(dieseg->divisions * 
	    (new_ds->length/dieseg->length) + 1.0);
	  dieseg->divisions = (int)(dieseg->divisions *
            nmmtl_arc_die_length(dieseg)/dieseg->length + 1.00);
	  dieseg->length = nmmtl_arc_die_length(dieseg);
	  
	  break;
	  
	case 8 :
	  /*
	    Chordal terminating                
	    
	    Actions:                              
	    
	    fracture conductor into 2 parts, set  
	    epsilons.                             
	    
	    interior part of die removed.         
	    */
	  /* This is a simplified version of #7 above */
	  
	  
	  /* create two new conductor circle segments */
          new_cs = (CIRCLE_SEGMENTS_P) malloc(sizeof(CIRCLE_SEGMENTS));
	  new_cs->centerx = segment->centerx;
	  new_cs->centery = segment->centery;
	  new_cs->radius = segment->radius;
	  new_cs->conductor = segment->conductor;
	  /* hook into the list */
	  new_cs->next = segment->next;
	  segment->next = new_cs;
	  new_cs->endangle = segment->endangle;
	  new_cs->epsilon[1] = segment->epsilon[1];
	  
	  /* find which intersection comes first on circle segment */
	  
	  /* find the angles of the intersections */
	  inter_angle[0] = 
	    nmmtl_cirseg_point_angle(segment,intersection1.x,intersection1.y);
          inter_angle[1] =
	    nmmtl_cirseg_point_angle(segment,intersection2.x,intersection2.y);
	  
          if(ip & (IP_I2D0 | IP_I2D1))
          {
	    /* intersection2 is where die endpoint hit, intersection1 
	       splits up the conductor segments */
	    
	    /* set up the coordinates */
	    segment->endangle = inter_angle[0];
	    new_cs->startangle = inter_angle[0];
	    
	    if(ip & IP_I2D1)
	    {
	      /* from intersection1, initial end of die is outside conductor */
	      segment->epsilon[1] = dieseg->epsilonplus;
	      new_cs->epsilon[0] = dieseg->epsilonminus;
	      nmmtl_arc_die_set_end(dieseg, &intersection1);
	    }
	    else /* ip & IP_I2D0 */
	    {
	      /* from intersection1, terminal end of die is outside
		 conductor */
	      segment->epsilon[1] = dieseg->epsilonminus;
	      new_cs->epsilon[0] = dieseg->epsilonplus;
	      nmmtl_arc_die_set_start(dieseg, &intersection1);
	    }
	  }
	  else  /* ip & (IP_I1D0 | IP_I1D1) */
          {
	    /* intersection1 is where die endpoint hit, intersection2 
	       splits up the conductor segments */
	    
	    /* set up the coordinates */
	    segment->endangle = inter_angle[1];
	    new_cs->startangle = inter_angle[1];
	    
	    if(ip & IP_I1D1)
	    {
	      /* from intersection2, initial end of die is outside conductor */
	      segment->epsilon[1] = dieseg->epsilonplus;
	      new_cs->epsilon[0] = dieseg->epsilonminus;
	      nmmtl_arc_die_set_end(dieseg, &intersection2);
	    }
	    else /* ip & IP_I1D0 */
	    {
	      /* from intersection2, terminal end of die is outside
		 conductor */
	      segment->epsilon[1] = dieseg->epsilonminus;
	      new_cs->epsilon[0] = dieseg->epsilonplus;
	      nmmtl_arc_die_set_start(dieseg, &intersection2);
	    }
          }
	  
	  
	  /* finally, compute the redistribution of divisions based on
	     length */
          new_cs->radians = new_cs->endangle - new_cs->startangle;
	  new_cs->divisions = (int)(segment->divisions *
	    (new_cs->radians / segment->radians) + 1.0);
	  segment->divisions += 1 - new_cs->divisions;
	  segment->radians -= new_cs->radians;
	  
	  dieseg->divisions = (int)(dieseg->divisions * 
	    (nmmtl_arc_die_length(dieseg)/dieseg->length) + 1.0);
	  dieseg->length = nmmtl_arc_die_length(dieseg);
	  /* flag that we changed the dieseg and dseg needs to be 
	     recomputed */
	  new_ds = (DIELECTRIC_SEGMENTS_P)1;
	  
	  break;
	  
	case 9 :
	  /*
	    Chordal bi-terminating             
	    
	    Actions: die removed.                 
	    */
	  
	  /* remove die */
	  if(last_dieseg != NULL)
	  {
	    last_dieseg->next = dieseg->next; /* bypass on list */
	    free(dieseg);
	    dieseg = last_dieseg->next;
	  }
	  else
	  {
	    /* removing first element on the list */
	    *dielectric_segments = (*dielectric_segments)->next;
	    free(dieseg);
	    dieseg = *dielectric_segments; 
	  }
	  break_out_of_conductor_loop = TRUE;
	  break;
	  
	case 10 :
	  /*
	    Tangential plain                  
	    
	    Actions: Do nothing                   
	    */
	  
	  break;
	  
	case 11 :
	  /*
	    Tangential terminating            
	    
	    Actions: Do nothing                   
	    */
	  
	  break;
	  
	case 12 :
	  /*
	    Tangential terminating at endpoint
	    die outside                           
	    
	    Actions: set epsilon on conductor     
	    */
	  
	  /* which end of conductor segment and then which end of die 
	     determine epsilon value to use */
	  if(ip & IP_I1C0)
	  {
	    if(ip & IP_I1D0) segment->epsilon[0] = dieseg->epsilonplus;
	    segment->epsilon[0] = dieseg->epsilonminus;
	  }
	  else  /* ip & IP_I1C1 */
	  {
	    if(ip & IP_I1D1) segment->epsilon[1] = dieseg->epsilonplus;
	    segment->epsilon[1] = dieseg->epsilonminus;
	  }
	  break;
	  
	case 13 :
	  /*
	    Tangential terminating at endpoint
	    die both sides                        
	    
	    Actions: set epsilon on conductor     
	    */
	  /* determine which way die segment is going by testing angle 
	     from normal to segment (initial to terminal) */
	  angle_to_normal =
	    nmmtl_cirseg_angle_to_normal(segment,&intersection1,&dseg,0);
	  if(angle_to_normal < 0.0)
	  {
	    /* initial endpoint of die is left turn from normal */
	    if(ip & IP_I1C0) segment->epsilon[0] = dieseg->epsilonminus; 
	    else segment->epsilon[1] = dieseg->epsilonplus; 
	  }
	  else
	  {
	    /* initial endpoint of die is right turn from normal */
	    if(ip & IP_I1C0) segment->epsilon[0] = dieseg->epsilonplus; 
	    else segment->epsilon[1] = dieseg->epsilonminus; 
	  }
	  
	  
	  break;
	  
	case 14 :
	  /*
	    Tangential terminating at endpoint
	    die "inside"                          
	    
	    Actions: Nothing                      
	    */
	  
	  break;
	  
	case 15 :
	  /*
	    Chordal on conductor endpoints    
	    
	    Actions:                              
	    
	    set epsilons.                         
	    
	    
	    middle part of die removed.  New piece
	    created.                              
	    */
	  
	  /* Create new dielectric segment by splitting the old one. */
	  new_ds = 
	    (DIELECTRIC_SEGMENTS_P)malloc(sizeof(DIELECTRIC_SEGMENTS));
	  *new_ds = *dieseg;
	  new_ds->next = dieseg->next;
	  dieseg->next = new_ds;
	  new_ds->at = dieseg->at;
	  new_ds->end = dieseg->end;
	  new_ds->epsilonplus = dieseg->epsilonplus;
	  new_ds->epsilonminus = dieseg->epsilonminus;
	  new_ds->segment_number = dieseg->segment_number;
	  new_ds->end_in_conductor = dieseg->end_in_conductor;
	  new_ds->orientation = dieseg->orientation;
	  /* neither ends in a conductor - so clear the bits */
	  dieseg->end_in_conductor &= 0XFFFD;  /* clear bit 2 */
	  new_ds->end_in_conductor &= 0XFFFE;  /* clear bit 1 */
	  
	  if(ip & IP_I1C0)
	  {
	    
	    /* intersection1 is first */
	    
	    /* which end of die goes inside ? */
	    angle_to_normal =
	      nmmtl_cirseg_angle_to_normal(segment,&intersection1,&dseg,0);
	    if(fabs(angle_to_normal) < PI/2)
	    {
	      /* terminal end of die is closest to intersection1 */
	      segment->epsilon[0] = dieseg->epsilonplus;
	      segment->epsilon[1] = dieseg->epsilonplus;
	      nmmtl_arc_die_set_start(new_ds, &intersection1);
	      nmmtl_arc_die_set_end(dieseg, &intersection2);
	      
	    }
	    else
	    {
	      /* initial end of die is closest to intersection1 */
	      segment->epsilon[0] = dieseg->epsilonminus;
	      segment->epsilon[1] = dieseg->epsilonminus;
	      nmmtl_arc_die_set_start(new_ds, &intersection2);
	      nmmtl_arc_die_set_end(dieseg, &intersection1);
	    }
	  }
	  else /* ip & IP_I2C0 */
	  {
	    /* intersection2 is first */
	    
	    /* which end of die goes inside ? */
	    angle_to_normal =
	      nmmtl_cirseg_angle_to_normal(segment,&intersection2,&dseg,0);
	    if(fabs(angle_to_normal) < PI/2)
	    {
	      /* from intersection2, initial end of die is inside conductor */
	      segment->epsilon[0] = dieseg->epsilonplus;
	      segment->epsilon[1] = dieseg->epsilonplus;
	      nmmtl_arc_die_set_start(new_ds, &intersection2);
	      nmmtl_arc_die_set_end(dieseg, &intersection1);
	      
	    }
	    else
	    {
	      /* from intersection1, initial end of die is outside conductor */
	      segment->epsilon[0] = dieseg->epsilonminus;
	      segment->epsilon[1] = dieseg->epsilonminus;
	      nmmtl_arc_die_set_start(new_ds, &intersection1);
	      nmmtl_arc_die_set_end(dieseg, &intersection2);
	    }
	  }
	  
	  
	  /* finally, compute the redistribution of divisions based on
	     length */
	  new_ds->length = nmmtl_arc_die_length(new_ds);
	  new_ds->divisions = (int)(dieseg->divisions * 
	    (new_ds->length/dieseg->length) + 1.0);
	  dieseg->length -= new_ds->length;
	  dieseg->divisions -= (new_ds->divisions - 1);
	  
	  
	  break;
	  
	case 16 :
	  /*
	    Chordal on conductor endpoints    
	    and one die endpoint              
	    Actions:                              
	    
	    set epsilons.                         
	    
	    
	    middle part of die removed.  Shrink   
	    leftover.                             
	    */
	  
	  if(ip & IP_I1D0)
	  {
	    /* terminal end of die is overhanging beyond intersection2 */
	    nmmtl_arc_die_set_start(dieseg, &intersection2);
	    
	    /* which side is conductor ? */
	    
	    if(ip & IP_I1C0)
	    {
	      segment->epsilon[0] = dieseg->epsilonminus;
	      segment->epsilon[1] = dieseg->epsilonminus;
	    }
	    else /* ip & IP_I1C1 */
	    {
	      segment->epsilon[0] = dieseg->epsilonplus;
	      segment->epsilon[1] = dieseg->epsilonplus;
	    }
	  }
	  else if(ip & IP_I2D0)
	  {
	    /* terminal end of die is overhanging beyond intersection1 */
	    nmmtl_arc_die_set_start(dieseg, &intersection1);
	    
	    /* which side is conductor ? */
	    
	    if(ip & IP_I2C0)
	    {
	      segment->epsilon[0] = dieseg->epsilonminus;
	      segment->epsilon[1] = dieseg->epsilonminus;
	    }
	    else /* ip & IP_I2C1 */
	    {
	      segment->epsilon[0] = dieseg->epsilonplus;
	      segment->epsilon[1] = dieseg->epsilonplus;
	    }
	  }
	  else if(ip & IP_I1D1)
	  {
	    /* initial end of die is overhanging beyond intersection2 */
	    nmmtl_arc_die_set_end(dieseg, &intersection2);
	    
	    /* which side is conductor ? */
	    
	    if(ip & IP_I1C0)
	    {
	      segment->epsilon[0] = dieseg->epsilonplus;
	      segment->epsilon[1] = dieseg->epsilonplus;
	    }
	    else /* ip & IP_I1C1 */
	    {
	      segment->epsilon[0] = dieseg->epsilonminus;
	      segment->epsilon[1] = dieseg->epsilonminus;
	    }
	  }
	  else /* ip & IP_I2D1 */
	  {
	    /* initial end of die is overhanging beyond intersection1 */
	    nmmtl_arc_die_set_end(dieseg, &intersection1);
	    
	    /* which side is conductor ? */
	    
	    if(ip & IP_I2C0)
	    {
	      segment->epsilon[0] = dieseg->epsilonplus;
	      segment->epsilon[1] = dieseg->epsilonplus;
	    }
	    else /* ip & IP_I2C1 */
	    {
	      segment->epsilon[0] = dieseg->epsilonminus;
	      segment->epsilon[1] = dieseg->epsilonminus;
	    }
	  }
	  
	  /* finally, compute the redistribution of divisions based on
	     ratio of new length to old length */
	  
	  dieseg->divisions = (int)(dieseg->divisions * 
	    (nmmtl_arc_die_length(dieseg)/dieseg->length) + 1.0);
	  dieseg->length = nmmtl_arc_die_length(dieseg);
	  
	  /* flag that we changed the dieseg and dseg needs to be 
	     recomputed */
	  new_ds = (DIELECTRIC_SEGMENTS_P)1;
	  
	  break;
	  
	case 17 :
	  /*
	    Chordal on conductor endpoints    
	    and both die endpoints            
	    
	    Actions: die removed                  
	    */
	  
	  /* remove die */
	  if(last_dieseg != NULL)
	  {
	    last_dieseg->next = dieseg->next; /* bypass on list */
	    free(dieseg);
	    dieseg = last_dieseg->next;
	  }
	  else
	  {
	    /* removing first element on the list */
	    *dielectric_segments = (*dielectric_segments)->next;
	    free(dieseg);
	    dieseg = *dielectric_segments; 
	  }
	  break_out_of_conductor_loop = TRUE;
	  break;
	  
	case 18 :
	  /*
	    Chordal on one conductor endpoint 
	    and no die endpoints              
	    
	    Actions:                              
	    
	    die piece added, original shrunk to   
	    remove middle section                 
	    
	    fracture circle segment, epsilon values set                    
	    */
	  /* create new conductor circle segment */
	  new_cs = (CIRCLE_SEGMENTS_P) malloc(sizeof(CIRCLE_SEGMENTS));
	  new_cs->centerx = segment->centerx;
	  new_cs->centery = segment->centery;
	  new_cs->radius = segment->radius;
	  new_cs->conductor = segment->conductor;
	  new_cs->endangle = segment->endangle;
	  new_cs->epsilon[1] = segment->epsilon[1];
	  /* hook into the list */
	  new_cs->next = segment->next;
	  segment->next = new_cs;
	  
	  /* Create new dielectric segment by splitting the old one. */
	  new_ds = 
	    (DIELECTRIC_SEGMENTS_P)malloc(sizeof(DIELECTRIC_SEGMENTS));
	  *new_ds = *dieseg;
	  new_ds->next = dieseg->next;
	  dieseg->next = new_ds;
	  new_ds->at = dieseg->at;
	  new_ds->end = dieseg->end;
	  
	  new_ds->epsilonplus = dieseg->epsilonplus;
	  new_ds->epsilonminus = dieseg->epsilonminus;
	  new_ds->segment_number = dieseg->segment_number;
	  new_ds->end_in_conductor = dieseg->end_in_conductor;
	  new_ds->orientation = dieseg->orientation;
	  /* neither ends in a conductor - so clear the bits */
	  dieseg->end_in_conductor &= 0XFFFD;  /* clear bit 2 */
	  new_ds->end_in_conductor &= 0XFFFE;  /* clear bit 1 */
	  
	  /* find the angle of the intersections */
	  inter_angle[0] =
	    nmmtl_cirseg_point_angle(segment,intersection1.x,intersection1.y);
	  inter_angle[1] =
	    nmmtl_cirseg_point_angle(segment,intersection2.x,intersection2.y);
	  
	  /* which intersection was the one at the conductor endpoint? */
	  if(ip & (IP_I1C0 | IP_I1C1))
	  {
	    /* intersection1 is at conductor endpoint, intersection2 
	       splits the circle segment */
	    
	    /* set up the coordinates */
	    segment->endangle = inter_angle[1];
	    new_cs->startangle = inter_angle[1];
	    
	    /* which end of die goes inside from intersection2 ? */
	    angle_to_normal =
	      nmmtl_cirseg_angle_to_normal(segment,&intersection2,&dseg,0);
	    if(fabs(angle_to_normal) < PI/2)
	    {
	      /* from intersection2, initial end of die is inside conductor */
	      
	      nmmtl_arc_die_set_start(new_ds, &intersection2);
	      nmmtl_arc_die_set_end(dieseg, &intersection1);
	      
	      segment->epsilon[1] = dieseg->epsilonminus;
	      new_cs->epsilon[0] = dieseg->epsilonplus;
	      
	      /* which side of conductor circle segment is hit? */
	      if(ip & IP_I1C0)
	      {
		/* initial side of conductor is at intersection */
		segment->epsilon[0] = dieseg->epsilonminus;
	      }
	      else
	      {
		/* terminal side of conductor is at intersection */
		new_cs->epsilon[1] = dieseg->epsilonplus;
	      }
	    }
	    else
	    {
	      /* from intersection2, initial end of die is outside conductor */
	      
	      nmmtl_arc_die_set_start(new_ds, &intersection1);
	      nmmtl_arc_die_set_end(dieseg, &intersection2);
	      
	      segment->epsilon[1] = dieseg->epsilonplus;
	      new_cs->epsilon[0] = dieseg->epsilonminus;
	      
	      /* which side of conductor circle segment is hit? */
	      if(ip & IP_I1C0)
	      {
		/* initial side of conductor is at intersection */
		segment->epsilon[0] = dieseg->epsilonplus;
	      }
	      else
	      {
		/* terminal side of conductor is at intersection */
		new_cs->epsilon[1] = dieseg->epsilonminus;
	      }
	    }
	  }
	  else /* ip & (IP_I2C0 | IP_I2C1) */
	  {
	    /* intersection2 is at conductor endpoint, intersection1 
	       splits the circle segment */
	    
	    /* set up the coordinates */
	    segment->endangle = inter_angle[0];
	    new_cs->startangle = inter_angle[0];
	    
	    /* which end of die goes inside from intersection1 ? */
	    angle_to_normal =
	      nmmtl_cirseg_angle_to_normal(segment,&intersection1,&dseg,0);
	    if(fabs(angle_to_normal) < PI/2)
	    {
	      /* from intersection1, initial end of die is inside conductor */
	      
	      nmmtl_arc_die_set_start(new_ds, &intersection1);
	      nmmtl_arc_die_set_end(dieseg, &intersection2);
	      
	      segment->epsilon[1] = dieseg->epsilonminus;
	      new_cs->epsilon[0] = dieseg->epsilonplus;
	      
	      /* which side of conductor circle segment is hit? */
	      if(ip & IP_I2C0)
	      {
		/* initial side of conductor is at intersection */
		segment->epsilon[0] = dieseg->epsilonminus;
	      }
	      else
	      {
		/* terminal side of conductor is at intersection */
		new_cs->epsilon[1] = dieseg->epsilonplus;
	      }
	    }
	    else
	    {
	      /* from intersection1, initial end of die is outside conductor */
	      
	      nmmtl_arc_die_set_start(new_ds, &intersection2);
	      nmmtl_arc_die_set_end(dieseg, &intersection1);
	      
	      segment->epsilon[1] = dieseg->epsilonplus;
	      new_cs->epsilon[0] = dieseg->epsilonminus;
	      
	      /* which side of conductor circle segment is hit? */
	      if(ip & IP_I1C0)
	      {
		/* initial side of conductor is at intersection */
		segment->epsilon[0] = dieseg->epsilonplus;
	      }
	      else
	      {
		/* terminal side of conductor is at intersection */
		new_cs->epsilon[1] = dieseg->epsilonminus;
	      }
	    }
	  }
	  
	  /* finally, compute the redistribution of divisions based on
	     length and angle */
	  new_ds->length = nmmtl_arc_die_length(new_ds);
	  new_ds->divisions = (int)(dieseg->divisions * 
	    (new_ds->length/dieseg->length) + 1.0);
	  dieseg->divisions -= (new_ds->divisions - 1);
	  dieseg->length -= new_ds->length;
	  
	  new_cs->radians = new_cs->endangle - new_cs->startangle;
	  new_cs->divisions = (int)(segment->divisions *
	    (new_cs->radians / segment->radians) + 1.0);
	  segment->divisions += 1 - new_cs->divisions;
	  segment->radians -= new_cs->radians;
	  
	  break;
	  
	case 19 :
	  /*
	    Chordal on one conductor endpoint 
	    and one die endpoint              
	    
	    Actions: die removed by shrinking     
	    the original                       
	    
	    Epsilon set.                          
	    */
	  if(ip & IP_I1D0)
	  {
	    /* reduce die segment size by moving ending point to 
	       intersection2 */
	    nmmtl_arc_die_set_end(dieseg, &intersection2);
	    if(ip & IP_I2C0)
	      segment->epsilon[0] = dieseg->epsilonplus;
	    else /* ip & IP_I2C1 */
	      segment->epsilon[1] = dieseg->epsilonminus;
	  }
	  else if(ip & IP_I1D1)
	  {
	    /* reduce die segment size by moving starting point to 
	       intersection2 */
	    nmmtl_arc_die_set_start(dieseg, &intersection2);
	    if(ip & IP_I2C0)
	      segment->epsilon[1] = dieseg->epsilonminus;
	    else /* ip & IP_I2C1 */
	      segment->epsilon[0] = dieseg->epsilonplus;
	  }
	  else if(ip & IP_I2D0)
	  {
	    /* reduce die segment size by moving ending point to 
	       intersection1 */
	    nmmtl_arc_die_set_end(dieseg, &intersection1);
	    if(ip & IP_I1C1)
	      segment->epsilon[1] = dieseg->epsilonminus;
	    else /* ip & IP_I1C0 */
	      segment->epsilon[0] = dieseg->epsilonplus;
	  }
	  else /* if(ip & IP_I2D1) */
	  {
	    /* reduce die segment size by moving starting point to 
	       intersection1 */
	    nmmtl_arc_die_set_start(dieseg, &intersection1);
	    if(ip & IP_I1C1)
	      segment->epsilon[1] = dieseg->epsilonplus;
	    else /* ip & IP_I1C0 */
	      segment->epsilon[0] = dieseg->epsilonminus;
	  }
	  
	  /* adjust divisions and set new length */
	  dieseg->divisions = (int)(dieseg->divisions *
	    nmmtl_arc_die_length(dieseg)/dieseg->length + 1.0);
	  dieseg->length = nmmtl_arc_die_length(dieseg);
	  
	  /* flag that we changed the dieseg and dseg needs to be 
	     recomputed */
	  new_ds = (DIELECTRIC_SEGMENTS_P)1;
	  
	  break;
	  
	case 20 :
	  /*
	    Chordal on conductor endpoints    
	    and both die endpoints            
	    
	    Actions: die removed                  
	    */
	  
	  /* remove die */
	  
	  if(last_dieseg != NULL)
	  {
	    last_dieseg->next = dieseg->next; /* bypass on list */
	    free(dieseg);
	    dieseg = last_dieseg->next;
	  }
	  else
	  {
	    /* removing first element on the list */
	    *dielectric_segments = (*dielectric_segments)->next;
	    free(dieseg);
	    dieseg = *dielectric_segments; 
	  }
	  break_out_of_conductor_loop = TRUE;
	  break;
	  
	case 21 :
	  /*
	    Chordal intersection on one conductor endpoint 
	    and different intersection on one die endpoint              
	    
	    Actions: die removed by shrinking     
	    the original                       
	    
	    fracture circle segment, epsilon values set                    
	    
	    */
	  
	  /* create new conductor circle segment */
	  new_cs = (CIRCLE_SEGMENTS_P) malloc(sizeof(CIRCLE_SEGMENTS));
	  new_cs->centerx = segment->centerx;
	  new_cs->centery = segment->centery;
	  new_cs->radius = segment->radius;
	  new_cs->conductor = segment->conductor;
	  new_cs->endangle = segment->endangle;
	  new_cs->epsilon[1] = segment->epsilon[1];
	  /* hook into the list */
	  new_cs->next = segment->next;
	  segment->next = new_cs;
	  
	  if( ip & (IP_I1D0 | IP_I1D1) )
	  {
	    /* set up the coordinates */
	    intersection_angle =
	      nmmtl_cirseg_point_angle(segment,intersection2.x,
				       intersection2.y);
	    if(ip & IP_I1D0)
	    {
	      /* reduce die segment size by moving starting point to 
		 intersection2 */
	      nmmtl_arc_die_set_start(dieseg, &intersection2);
	      segment->epsilon[1] = dieseg->epsilonminus;
	      new_cs->epsilon[0] = dieseg->epsilonplus;
	    }
	    else
	    {
	      /* reduce die segment size by moving ending point to 
		 intersection2 */
	      nmmtl_arc_die_set_end(dieseg, &intersection2);
	      segment->epsilon[1] = dieseg->epsilonplus;
	      new_cs->epsilon[0] = dieseg->epsilonminus;
	    }
	    
	  }
	  else /* ip & (IP_I2D0 | IP_I2D1) */
	  {
	    /* set up the coordinates */
	    intersection_angle =
	      nmmtl_cirseg_point_angle(segment,intersection1.x,
				       intersection1.y);
	    if(ip & IP_I2D0)
	    {
	      /* reduce die segment size by moving starting point to 
		 intersection1 */
	      nmmtl_arc_die_set_start(dieseg, &intersection1);
	      segment->epsilon[1] = dieseg->epsilonminus;
	      new_cs->epsilon[0] = dieseg->epsilonplus;
	    }
	    else
	    {
	      /* reduce die segment size by moving ending point to 
		 intersection1 */
	      nmmtl_arc_die_set_end(dieseg, &intersection1);
	      segment->epsilon[1] = dieseg->epsilonplus;
	      new_cs->epsilon[0] = dieseg->epsilonminus;
	    }
	  }
	  
	  /* adjust divisions and set new length */
	  dieseg->divisions = (int)(dieseg->divisions *
	    nmmtl_arc_die_length(dieseg)/dieseg->length + 1.0);
	  dieseg->length = nmmtl_arc_die_length(dieseg);
	  
	  segment->endangle = intersection_angle;
	  new_cs->startangle = intersection_angle;
	  new_cs->radians = new_cs->endangle - new_cs->startangle;
	  new_cs->divisions = (int)(segment->divisions *
	    (new_cs->radians / segment->radians) + 1.0);
	  segment->divisions += 1 - new_cs->divisions;
	  segment->radians -= new_cs->radians;
	  
	  /* flag that we changed the dieseg and dseg needs to be 
	     recomputed */
	  new_ds = (DIELECTRIC_SEGMENTS_P)1;
	  
	  break;
	  
	  default :
	  {
	    
	    fprintf(stderr,"ELECTRO-F-INTERNAL Internal error:  checking intersections between conductors and dielectrics; Choices for circle segment/die intersection \
types fell through\n");
	    return(FAIL);
	  }
	  
	}                          /* switch on intersection type */  
	
      }                            /* if there is an intersection */
      
      last_segment = segment;
      segment = segment->next;
    }                                /* while looping through the segments */
    
    if(break_out_of_conductor_loop == FALSE)
    {
      last_dieseg = dieseg;
      dieseg = dieseg->next;
    }
    
  }                              /* looping on the dielectric segs */
  return(SUCCESS);
  
}
