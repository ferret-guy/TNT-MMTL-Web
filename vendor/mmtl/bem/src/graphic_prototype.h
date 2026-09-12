/***************************************************************************\
*                                                                           *
*   ROUTINE NAME        graphic_prototype.h                                 *
*                                                                           *
*   ABSTRACT            This include file contains the subroutine prototype *
*                       of the graphic wrappers.                            *
*                                                                           *
*   AUTHOR          Sharon Zahn                                             *
*                                                                           *
*   CREATION DATE                                                           *
*                                                                           *
*        Copyright (C) 1992 by Mayo Foundation.  All rights reserved.       *
*        Copyright (C) 1993 by Mayo Foundation.  All rights reserved.       *
*                                                                           *
*   MODIFICATION HISTORY                                                    *
*      1.00 Original                                         SKZ  22-05-92  *
*                                                                           *
\***************************************************************************/

#ifndef graphic_prototype_h
#define graphic_prototype_h

typedef int (*pToRedraw)(int );

void world_to_virtual (double wx, double wy, int *x, int *y);

void rectangle_abs_2 (double x0, double y0, double x1, double y1, int eventType);

void get_actual_viewport (double , double , double , double , 
        double *, double *, double *, double *);

char GetKeyboardCharacter (void);
char XGetChar (int * );
void XGetCharOff (void);
void GetResponse (int );

void get_current_pos (double *x, double *y, double *z);
int get_text_line(double vx, double vy, char *line, 
		  int window_name=0,
boolean flag= (boolean) 0);
void get_text_window_structure(int window_name,GRAPHIC_TEXT_WINDOW **str);
void get_text_window_structure(double vx,double vy, 
			       GRAPHIC_TEXT_WINDOW **str);

void inquire_position (double *x, double *y, double *z);
void append_segment_storage (int level, int cnflct);
void arc_abs_2 (double x0, double y0, double z0, double radius, int nseg, 
                double a0, double a1);
void begin_batch (int level);
void end_batch (void);
void cartesian_viewing_xform (double xvrp, double yvrp, double zvrp, double xeye, 
                              double yeye, double zeye, double vangle);
void def_polygon_edge_style (int value);
void def_polygon_interior_style (int value);
void def_fill_index (int value, int intensity);
void def_visibility (int value);
void circle_abs_2 (double x0, double y0, double radius, int nseg);
void set_color (int value);
void close_ret_segment (void);
void set_linestyle (int value);
void linestyle (int value);
void close_temp_segment (void);
void color_table (int dspdev, int count, int *indexes, int *hues, int *sats, 
                  int *lights);
void concat_xform_matrices (double *m1, double *m2, double *m3);
void continue_pick (int dspdev, int *namseg, int *pickid);
void copy_segment (int frmnam, int toname, int transf);
void create_ret_segment (int name);
void delete_segment (int name);
void create_temp_segment (void);
void def_char_baseline (double xbase, double ybase, double zbase);
void def_char_size (double cx, double cy);
void def_char_justification (int horiz, int vert);
void def_color (int value);
void deselect_device (int dspdev);
void echo_position (int dspdev, int inpfct, int phydev, double vx, double vy);
void set_locator_echo (int seg_number, double vxmin, double vxmax, 
                       double vymin, double vymax);
void set_pick_echo (int seg_number, double vxmin, double vxmax, 
                    double vymin, double vymax);
void enable_input (int dspdev, int inpfct, int phydev);
void end_graphics (void);
void fetch_metafile_item (int dspdev, int length, int *item);
void set_fill_area_bundle (int fill_type, int *fill, int fill_indx, 
                           int *color_array, int num_colors, int index);
void set_mono_fill_area_bundle (int fill_type, int fill_indx, int index);
void restart_graphic_counts (void);
void init_device (int dspdev, char *);
void init_device (int outdev, char *hardcopyFile, pToRedraw reDrawFunc);
void init_graphics (void);
void inquire_aspect_ratio (int dspdev, double *ratio);
void aspect_ratio (int dspdev, double *ratio);
void move_abs_2 (double x, double y);
void line_abs_2 (double x, double y);
void line_rel_2 (double dx, double dy);
void def_linewidth (int value);
void def_marker_symbol (int value);
void load_prim_att (int *iarray);
void load_primitive_attributes (int *iarray);
void load_view_att (double *array);
void load_viewing_xform (double *iarray);
void map_coords(double vmin, double vmax, double wmin, double wmax, 
		double vin, double *wout );
void marker_abs_2 (double x, double y);
void marker_rel_2 (double dx, double dy);
void move_rel_2 (double dx, double dy);
void new_frame (void);
void next_line (double gap);
void output_escape_function (int code, int ninteg, int nreal, int *ilist, 
                             double *rlist);
void parallel_oblique_projection (double du, double dv, double dn);
void parallel_projection (void);
void pause_device (int dspdev);
void perspective_oblique_projection (double du, double dv, double dn);
void perspective_projection (double dn);
void pick_aperture (int dspdev, int phydev, double dx, double dy);
void polyline_abs_2 (double *x, double *y, int n);
void polygon_abs_2 (double *x, double *y, int n);
void polyline_rel_2 (double *dx, double *dy, int n);
void polygon_rel_2 (double *dx, double *dy, int n);
void polymarker_abs_2 (double *x, double *y, int n);
void polymarker_rel_2 (double *dx, double *dy, int n);
void box_abs_2 (double x0, double y0, double x1, double y1);
void rectangle_abs_2 (double x0, double y0, double x1, double y1);
void rectangle_rel_2 (double dx, double dy);
void rename_segment (int oldnam, int newnam);
void reset_primitive_attributes (void);
void reset_viewing_xform();
void restore_segment_storage (int level);
void save_prim_att (int *iarray);
void save_primitive_attributes (int *iarray);
void save_segment_storage();
void save_view_att (double *array);
void save_viewing_xform (double *array);
void sector_abs_2 (double x0, double y0, double z0, double radius, int nseg, 
                   double a0, double a1);
void seg_exists (int name, int *aarray);
void segment_exists (int name, int *aarray);
void segment_transform (int name, double px, double py, double sx, double sy, 
                        double rotang, double tx, double ty);
void segment_translation (int name, double tx, double ty);
void select_device (int dspdev);
void set_all_shields (int flag);
void set_all_visibility (int visflg);
void set_background_color (int color);
void set_char_baseline (double cxbase, double cybase, double czbase);
void set_char_font (int value);
void char_font (int value);
void set_char_gap (double value);
void set_char_justification (int horiz, int vert);
void char_justification (int horiz, int vert);
void set_char_path (int value );
void char_path (int value);
void set_char_plane (double xplan, double yplan, double zplan);
void set_char_size (double xsize, double ysize);
void char_size (double xsize, double ysize);
void try_set_the_color (int value);
void set_debug_level (int level);
void set_detectability (int name, int detval);
void set_di3000_file_luns (int code, int dspdev, int lun);
void set_di3000_filenames (int code, int dspdev, int lun, char *filnam);
void set_fatal_level (int level);
void set_fill_index (int color, int inten);
void fill_index (int color, int inten);
void set_handedness (int value);
void set_highlighting (int name, int hiflg);
void set_intensity (int value );
void set_linewidth (int value);
void linewidth (int value);
void set_marker_symbol (int value);
void marker_symbol (int value);
void set_metafile_format (int dspdev, int iftype, int oftype);
void setWindow (int );
void window (double umin, double umax, double vmin, double vmax);
void window (int win, double umin, double umax, double vmin, double vmax);
void get_actual_viewport (double vxmin, double vxmax, double vymin, double vymax, 
        double *axmin, double *axmax, double *aymin, double *aymax);
void viewport_2 (double vxmin, double vxmax, double vymin, double vymax);
void set_ndc_space (double vxmin, double vxmax, double vymin, double vymax);
void reset_ndc_space (double vxmin, double vxmax, double vymin, double vymax);
void set_pen (int value);
void set_pick_id (int value);
void pick_id (int value);
void set_pick_list (int dspdev, int *namarr, int lenarr, int code);
void set_polygon_edge_style (int value);
void polygon_edge_style (int value);
void set_polygon_interior_style (int value);
void polygon_interior_style (int value);
void set_polygon_simulated_fill (int dspdev, int simmod);
void set_primitive_attribute (int attcod, int value);
void set_priority (int name, int segpri);
void set_right_margin (double x, double y, double z);
void set_sentinal_char (char strtf, char endf);
void set_shield (int regno, int flag);
void set_subscripts (double scale, double xlate);
void set_superscripts (double scale, double xlate);
void set_virtual_boundaries (double vxmin, double vxmax, 
                             double vymin, double vymax);
void set_visibility (int name, int visflg);
void set_xform_matrix (int value);
void shield_virtual (int regno, double vx0, double vy0, double vx1, double vy1);
void shield_world (int regno, double wx0, double wy0, double wx1, double wy1);
void smooth_polyline_2 (double *x, double *y, int n, double tensin, double arcpct);
void splines_abs_2 (double *x, double *y, int n, double tensin, double arcpct);
void software_pick (double vx, double vy, int dspdev, int *segnam, int *pickid);
void spherical_viewing_xform (double xvrp, double yvrp, double zvrp, double dist, 
                              double yangle, double xzangl, double vangle);
void terminate_device (int dspdev);
void text1_noflush (char *string);
void text1 (char *string);
void text2_noflush (char *string);
void text2 (char *string);
void text3_noflush (char *string);
void text3 (char *string);
void textgr_noflush (char *string);
void textgr (char *string);
void update_picture (void);
void view_ref_point (double x, double y, double z);
void viewplane_distance (double dist);
void viewplane_normal (double dx, double dy, double dz);
void set_viewport_2 (int transform_number, double vxmin, double vxmax, 
                     double vymin, double vymax);
void set_viewport (int norm_transform_no, double vxmin, double vxmax, 
                   double vymin, double vymax);
void viewport (double vxmin, double vxmax, double vymin, double vymax);
void viewup_vector (double dx, double dy, double dz);
void w3_to_ndc2 (double x, double y, double z, double *vx, double *vy);
void wait_button (int dspdev, int phydev, int echolv, int *button);
void wait_keyboard (int dspdev, int phydev, int echolv, int maxchr, 
                    char *string);
void wait_locator (int dspdev, int phydev, int echolv, int *button, 
                   double *vx, double *vy);
void wait_pick (int dspdev, int phydev, int echolv, int *button, int *segnam, 
                int *pickid);
void wait_stroke (int dspdev, int phydev, int echolv, int maxpts, 
                  double *vx, double *vy, int actual);
void wait_valuator (int dspdev, int phydev, int echolv, double start, 
                    int *button, double *value);
void window_clipping (int value);
void world_to_virtual (double x, double y, double z, double *vx, double *vy);
void write_metafile_data (int dspdev, int ninteg, int *ilist);
void write_metafile_picture_title (int dspdev, char *string);
void yon_clipping (int yflag);
void yon_plane_distance (double ydist);
int def_detectability (int detval);
int inquire_graphic_extent (char *string, double *xxtent, double *yxtent);
int inquire_device (int dspdev, int code, int *list);
void JLNSIM (int dspdev, int sim_type);
void ndc2_to_w3 (double vx, double vy, double *wx, double *wy, double *fdum);
void virtual_to_world (double vx, double vy, double *x, double *y, double *z);


#endif
