/* Well Closure Field App: stage checklists.
   DRAFT. These steps are a starting point for the team's engineers to review.
   They are not yet a statement of AER requirements. Edit freely: each stage has
   an id, a title, a short purpose line and a list of steps. A step with a
   `reading` asks for a measured value as well as a status. */
window.CHECKLISTS = [
  {
    id: "assess",
    title: "Site assessment",
    purpose: "Confirm the well, the site and what work it needs before anyone mobilizes.",
    steps: [
      { id: "id-sign", text: "Well sign and surface location match the licence" },
      { id: "access", text: "Landowner contacted and site access confirmed" },
      { id: "history", text: "Site history reviewed (spills, pits, flare, lease road)" },
      { id: "visual", text: "Walk-over done: stained soil, stressed vegetation, debris, odours" },
      { id: "features", text: "Surface features and equipment still on site recorded" },
      { id: "phase2", text: "Decision recorded on whether sampling (Phase 2) is needed" }
    ]
  },
  {
    id: "leak",
    title: "Leak checks",
    purpose: "Test for surface casing vent flow and gas migration and record the results.",
    steps: [
      { id: "scvf", text: "Surface casing vent flow test done", reading: { label: "Flow rate", unit: "m³/day" } },
      { id: "gm", text: "Gas migration test done", reading: { label: "Highest reading", unit: "% LEL" } },
      { id: "result", text: "Result recorded as pass, non-serious or serious" },
      { id: "report", text: "Positive result reported to the AER and to the licensee" }
    ]
  },
  {
    id: "decom",
    title: "Decommissioning",
    purpose: "Plug the well, cut and cap it below grade and clear the surface.",
    steps: [
      { id: "plugs", text: "Downhole plugs set and tested" },
      { id: "cut", text: "Casing cut below grade", reading: { label: "Depth below grade", unit: "m" } },
      { id: "cap", text: "Cap installed as required" },
      { id: "equip", text: "Surface equipment, anchors and debris removed" },
      { id: "filed", text: "Abandonment report filed with the AER" }
    ]
  },
  {
    id: "remed",
    title: "Remediation",
    purpose: "Find and clean up any contamination found during assessment.",
    steps: [
      { id: "delineate", text: "Contaminated areas delineated and mapped" },
      { id: "plan", text: "Remediation plan agreed with the licensee" },
      { id: "treat", text: "Soil removed or treated" },
      { id: "confirm", text: "Confirmation samples taken and results meet criteria" }
    ]
  },
  {
    id: "reclaim",
    title: "Reclamation",
    purpose: "Return the land to equivalent capability and get the reclamation certificate.",
    steps: [
      { id: "contour", text: "Site recontoured and drainage restored" },
      { id: "topsoil", text: "Topsoil replaced" },
      { id: "reveg", text: "Seeded or revegetated" },
      { id: "dsa", text: "Detailed site assessment against reclamation criteria" },
      { id: "landowner", text: "Landowner walk-through and sign-off" },
      { id: "apply", text: "Reclamation certificate application submitted" },
      { id: "cert", text: "Reclamation certificate received" }
    ]
  }
];
