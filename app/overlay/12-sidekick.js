// The chosen sidekick: the LED matrix dither blob, without the drips, with the agent layer on top.
Tiro.register(Tiro.ditherKit({
  id: 'sidekick', label: 'Sidekick', matrix: true, pixel: 1.3, glow: 0.55, speed: 80,
  // Tiro's colours: dark, rust (#8a3b1e), Tiro orange, warm glow, cream.
  pal: [[18, 10, 6], [120, 48, 22], [208, 119, 79], [242, 168, 120], [248, 240, 226]],
  plugin: (kit) => Tiro.agentPlugin?.(kit) ?? null,
}));
