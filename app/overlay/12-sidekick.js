// The chosen sidekick: the LED matrix dither blob, without the drips, with the agent layer on top.
Tiro.register(Tiro.ditherKit({
  id: 'sidekick', label: 'Sidekick', matrix: true, pixel: 1.3, glow: 0, speed: 80,
  // Tiro's colours (theme/tokens.js): slate, cyan over it, cyan, and the text colour. No glow.
  pal: window.TiroTheme.sprite,
  plugin: (kit) => Tiro.agentPlugin?.(kit) ?? null,
}));
