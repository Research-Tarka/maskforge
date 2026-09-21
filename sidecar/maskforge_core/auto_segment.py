"""Unsupervised auto-segmentation: proposes a draft multi-class mask from a
source image via clustering, for the user to correct with the existing
brush/bucket/polygon tools rather than paint from scratch.

Deliberately generic — no glacio-specific spectral indices, no assumption of
georeferencing. Clusters on per-pixel color plus a local texture measure, so
it applies to any raster image (satellite, aerial, or plain photo).

Unlike the DrawingTool interface (which targets one class at a time),
clustering produces a full-frame multi-class label map in a single pass, so
it lives outside TOOL_REGISTRY with its own entry point: ``auto_segment()``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
from scipy import ndimage as ndi

try:
    from sklearn.cluster import KMeans
    from sklearn.mixture import GaussianMixture

    SKLEARN_AVAILABLE = True
except ImportError:  # pragma: no cover
    KMeans = None
    GaussianMixture = None
    SKLEARN_AVAILABLE = False

ClusterMethod = Literal["kmeans", "gmm"]


@dataclass
class AutoSegmentResult:
    labels: np.ndarray  # (H, W) int array, cluster index per pixel (0..n_clusters-1), or -1 if excluded by pixel_mask
    n_clusters: int
    cluster_means: list[tuple[float, ...]]  # mean color per cluster, for UI legend/preview


def _texture_feature(gray: np.ndarray, size: int = 5) -> np.ndarray:
    """Local standard deviation over a size x size window — a cheap,
    generic texture measure (smooth ice/snow vs. rough rock/debris) that
    doesn't assume anything about the sensor or subject."""
    mean = ndi.uniform_filter(gray, size=size)
    mean_sq = ndi.uniform_filter(gray * gray, size=size)
    variance = np.clip(mean_sq - mean * mean, 0, None)
    return np.sqrt(variance)


def _merge_similar_clusters(
    labels_flat: np.ndarray,
    present: list[int],
    feature_means: dict[int, np.ndarray],
    merge_threshold: float,
) -> dict[int, int]:
    """Greedily merge clusters whose *normalized feature-space* means sit
    closer than ``merge_threshold`` apart, returning ``{old_id: merged_id}``.

    K-Means/GMM are asked for up to ``n_clusters`` groups and will use every
    one of them even when the image only has a couple of genuinely distinct
    regions -- the "extra" clusters end up as near-duplicates split by
    nothing but pixel noise (this is the well-known failure mode of picking
    k larger than the true number of clusters). Merging by feature-space
    distance -- not by raw RGB distance -- means the merge respects
    whatever the clustering itself considered close, including the texture
    channel when it's enabled.

    Greedy nearest-pair merging (repeatedly merge the two closest surviving
    clusters, updating the merged centroid as a size-weighted average) is
    the simplest hierarchical-agglomeration variant that gives a stable,
    order-independent-ish result without pulling in a full HAC dependency
    for what is only ever a handful of points (<= n_clusters, typically
    under 20).
    """
    sizes = {c: int(np.count_nonzero(labels_flat == c)) for c in present}
    centroids = {c: feature_means[c].copy() for c in present}
    merge_of: dict[int, int] = {c: c for c in present}
    live = set(present)

    while len(live) > 1:
        live_list = sorted(live)
        best_pair = None
        best_dist = np.inf
        for i, a in enumerate(live_list):
            for b in live_list[i + 1 :]:
                dist = float(np.linalg.norm(centroids[a] - centroids[b]))
                if dist < best_dist:
                    best_dist = dist
                    best_pair = (a, b)
        if best_pair is None or best_dist > merge_threshold:
            break

        a, b = best_pair
        total = sizes[a] + sizes[b]
        centroids[a] = (centroids[a] * sizes[a] + centroids[b] * sizes[b]) / max(total, 1)
        sizes[a] = total
        live.discard(b)
        for c in present:
            if merge_of[c] == b:
                merge_of[c] = a

    return merge_of


def auto_segment(
    image: np.ndarray,
    n_clusters: int = 4,
    method: ClusterMethod = "kmeans",
    use_texture: bool = True,
    sample_fraction: float = 0.25,
    random_state: int = 0,
    smooth_sigma: float = 0.8,
    merge_threshold: float = 2.2,
    pixel_mask: np.ndarray | None = None,
) -> AutoSegmentResult:
    """Cluster an image (H, W, C) into *up to* ``n_clusters`` groups by color
    (+ optional local texture), returning a per-pixel cluster label map.

    ``n_clusters`` is a ceiling, not a guarantee: K-Means/GMM are still
    asked to fit exactly that many components, but the result is trimmed
    down two ways so the preview stays a coarse, correctable draft rather
    than an over-segmented mess of near-duplicate groups:

    - ``smooth_sigma``: a light Gaussian blur applied to the image *before*
      feature extraction (color and texture both). This is not a
      post-clustering pixel-label filter (that erases genuinely small
      regions, e.g. a small isolated feature a few pixels across, by
      outvoting them into their surroundings) -- blurring the *input*
      instead damps single-pixel sensor/texture noise before it ever
      reaches the clustering, so noise doesn't masquerade as a real color
      difference and split into its own cluster, while still leaving small
      real regions with a real color signature that the clustering will
      still pick up.
    - ``merge_threshold``: clusters whose centroids end up closer than this
      in normalized feature space are greedily merged after fitting (see
      :func:`_merge_similar_clusters`). K-Means/GMM must always use exactly
      the k they're given, so asking for up to 16 groups on an image with
      only 3-4 real ones otherwise reliably produces a dozen near-duplicate
      splits of the same visual area, which is what makes the "draft"
      preview more confusing than useful.

    Fits on a random pixel subsample (``sample_fraction``) for speed on
    large images, then predicts labels for every pixel — this is the
    standard scalable-clustering pattern and keeps runtime sub-second on
    typical scene sizes even for k-means, which is otherwise O(n) per
    iteration over all pixels.

    ``pixel_mask``, if given, restricts both fitting and prediction to the
    ``True`` pixels (e.g. pixels not yet painted in the mask). Re-running
    auto-segment after accepting some clusters should re-cluster only what's
    still unassigned, rather than recomputing clusters over the whole image
    (including already-annotated regions) every time. Pixels outside the
    mask are labeled -1 and excluded from ``cluster_means``.
    """
    if not SKLEARN_AVAILABLE:
        raise RuntimeError("scikit-learn is required for auto-segmentation.")
    if image.ndim not in (2, 3):
        raise ValueError("image must be (H, W) or (H, W, C)")
    if n_clusters < 2:
        raise ValueError("n_clusters must be >= 2")

    h, w = image.shape[:2]
    if image.ndim == 2:
        color = image[..., np.newaxis].astype(np.float32)
    else:
        color = image.astype(np.float32)

    # Blur per-channel before deriving any feature -- see the smooth_sigma
    # note above. Small enough (sigma ~0.8px default) to not visibly erode
    # real region boundaries, but enough to stop single-pixel noise from
    # reading as its own color/texture signature.
    if smooth_sigma > 0:
        color_for_features = np.stack(
            [ndi.gaussian_filter(color[..., c], sigma=smooth_sigma) for c in range(color.shape[-1])],
            axis=-1,
        )
    else:
        color_for_features = color

    features = [color_for_features.reshape(-1, color_for_features.shape[-1])]

    if use_texture:
        gray = (
            color_for_features.mean(axis=-1)
            if color_for_features.shape[-1] > 1
            else color_for_features[..., 0]
        )
        texture = _texture_feature(gray).reshape(-1, 1)
        features.append(texture)

    X = np.concatenate(features, axis=1)

    if pixel_mask is not None:
        if pixel_mask.shape != (h, w):
            raise ValueError("pixel_mask must match image shape (H, W)")
        mask_flat = pixel_mask.reshape(-1)
    else:
        mask_flat = np.ones(h * w, dtype=bool)

    active_idx = np.flatnonzero(mask_flat)
    if active_idx.size == 0:
        raise ValueError("No unassigned pixels to segment.")

    X_active = X[active_idx]

    # Normalize each feature to comparable scale so texture doesn't get
    # drowned out by (or dominate) color magnitude. Stats are computed only
    # over the active (unassigned) pixels, so already-painted regions don't
    # skew the normalization of what's left to cluster.
    X_mean = X_active.mean(axis=0)
    X_std = X_active.std(axis=0)
    X_std[X_std == 0] = 1.0
    X_active_norm = (X_active - X_mean) / X_std

    n_pixels = X_active_norm.shape[0]
    sample_size = max(n_clusters * 50, int(n_pixels * sample_fraction))
    sample_size = min(sample_size, n_pixels)
    rng = np.random.default_rng(random_state)
    sample_idx = rng.choice(n_pixels, size=sample_size, replace=False)
    X_sample = X_active_norm[sample_idx]

    if method == "kmeans":
        model = KMeans(n_clusters=n_clusters, random_state=random_state, n_init=4)
        model.fit(X_sample)
        active_labels = model.predict(X_active_norm)
    elif method == "gmm":
        model = GaussianMixture(n_components=n_clusters, random_state=random_state)
        model.fit(X_sample)
        active_labels = model.predict(X_active_norm)
    else:
        raise ValueError(f"Unknown clustering method: {method!r}")

    labels_flat = np.full(h * w, -1, dtype=np.int32)
    labels_flat[active_idx] = active_labels

    color_flat = color.reshape(-1, color.shape[-1])  # unblurred, for the reported mean_color legend
    present = sorted(int(c) for c in np.unique(active_labels))

    if merge_threshold > 0 and len(present) > 1:
        feature_means = {c: X_active_norm[active_labels == c].mean(axis=0) for c in present}
        merge_of = _merge_similar_clusters(active_labels, present, feature_means, merge_threshold)
        active_labels = np.array([merge_of[int(c)] for c in active_labels], dtype=np.int32)
        labels_flat[active_idx] = active_labels
        present = sorted(set(merge_of.values()))

    # Order the surviving clusters by mean brightness (ascending) so label
    # indices are stable/interpretable across runs (cluster 0 = darkest)
    # rather than the arbitrary order the solver happens to converge to.
    color_active = color_flat[active_idx]
    brightness_by_cluster = {c: float(color_active[active_labels == c].mean()) for c in present}
    order = sorted(present, key=lambda c: brightness_by_cluster[c])

    remap = {old_idx: new_idx for new_idx, old_idx in enumerate(order)}
    active_labels = np.array([remap[int(c)] for c in active_labels], dtype=np.int32)
    labels_flat[active_idx] = active_labels
    labels = labels_flat.reshape(h, w).astype(np.int32)

    cluster_means = []
    for new_idx, old_idx in enumerate(order):
        pixels = color_active[active_labels == new_idx]
        mean_color = tuple(float(v) for v in pixels.mean(axis=0))
        cluster_means.append(mean_color)

    return AutoSegmentResult(labels=labels, n_clusters=len(order), cluster_means=cluster_means)
