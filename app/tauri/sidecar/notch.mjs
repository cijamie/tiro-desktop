// Where the agent appears (the panel's "Where I appear"): 'off' (beside the cursor, the default), or on a Mac with a
// notched screen, 'drop' (the capsule) or 'spread' (widening out of the notch). See app/overlay/notch.js.
export const pickNotch = ({ mac, notchScreen, pick }) => (mac && notchScreen && ['spread', 'drop'].includes(pick) ? pick : 'off');
