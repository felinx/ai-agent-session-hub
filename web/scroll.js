const EDGE_THRESHOLD = 4;
const SMOOTH_SCROLL_VIEWPORTS = 2;

export function jumpButtonState({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 }) {
  const maxScroll = scrollHeight - clientHeight;
  if (maxScroll <= EDGE_THRESHOLD) {
    return { visible: false, showTop: false, showBottom: false };
  }
  return {
    visible: true,
    showTop: scrollTop > EDGE_THRESHOLD,
    showBottom: scrollTop < maxScroll - EDGE_THRESHOLD
  };
}

// Smooth scrolling scales with distance and can take over ten seconds in a long session;
// jump instantly once the distance exceeds two viewport heights.
export function jumpScrollBehavior({ from = 0, to = 0, clientHeight = 0 }) {
  const distance = Math.abs(to - from);
  const limit = Math.max(clientHeight, 0) * SMOOTH_SCROLL_VIEWPORTS;
  return distance > limit ? 'auto' : 'smooth';
}
