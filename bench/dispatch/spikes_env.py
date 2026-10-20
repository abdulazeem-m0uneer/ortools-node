"""The read-only caby-dispatch spikes that gen_instances.py and run_py.py import, and their git revision."""
import os
import subprocess


def spikes_dir():
    """$CABY_DISPATCH_DIR/spikes, after checking that it holds the spikes; exits with a message otherwise."""
    root = os.environ.get("CABY_DISPATCH_DIR")
    if not root:
        raise SystemExit("CABY_DISPATCH_DIR is not set: point it at a caby-dispatch checkout "
                         "(the spikes are imported from its spikes/ortools)")
    spikes = os.path.join(root, "spikes")
    if not os.path.isfile(os.path.join(spikes, "ortools", "caby_model.py")):
        raise SystemExit(f"{spikes}/ortools/caby_model.py not found: check CABY_DISPATCH_DIR ({root})")
    return spikes


def spikes_revision(spikes):
    """The short git revision of the spikes checkout, or None outside git."""
    try:
        return subprocess.run(["git", "-C", spikes, "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                              check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
