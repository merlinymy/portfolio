---
name: peptideDesign
blurb: Cyclic-peptide design pipeline for a postdoctoral biochemistry researcher's cancer work (unpaid project).
dates: "2026"
tech: [Python, RFdiffusion, ProteinMPNN, AlphaFold, JAX, PyTorch]
order: 4
---

- Built a four-stage cyclic-peptide design pipeline (RFdiffusion → ProteinMPNN → AlphaFold validation → metric filter) for a postdoctoral biochemistry researcher; resolved a CUDA/JAX segfault that had blocked all prior work, and replaced a shape-only filter with a target-aligned pose RMSD (fold + dock), producing 16 of 80 designs that passed published accept criteria in a pilot run.
- Built and delivered GrooveScope, a dependency-free browser tool that lets a chemist define new mutant targets by clicking hotspot residues on a 3D structure and exports a config the pipeline consumes directly.
