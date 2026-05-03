const fs = require('fs');
let f = fs.readFileSync('web/src/components/dashboard/stream-player.tsx', 'utf8');

// Fix 1: No channel selected - add missing </div>
f = f.replace(
  '          <div><strong>No channel selected</strong><p>Open the channel drawer to launch a stream.</p></div>\n      </div>\n    );\n  }',
  '          <div><strong>No channel selected</strong><p>Open the channel drawer to launch a stream.</p></div>\n        </div>\n      </div>\n    );\n  }'
);

// Fix 2: Loading overlay - add missing </div>
f = f.replace(
  '              <div className="player-overlay-copy"><strong>Buffering stream…</strong><p>Recovering live edge. Please wait.</p></div>\n          </div>\n        )}',
  '              <div className="player-overlay-copy"><strong>Buffering stream…</strong><p>Recovering live edge. Please wait.</p></div>\n            </div>\n          </div>\n        )}'
);

// Fix 3: Error overlay - add missing </div>
f = f.replace(
  '              <div className="player-overlay-copy"><strong>Stream interrupted</strong><p>{error}</p></div>\n          </div>\n        )}',
  '              <div className="player-overlay-copy"><strong>Stream interrupted</strong><p>{error}</p></div>\n            </div>\n          </div>\n        )}'
);

// Fix 4: Footer - add missing </div> before error notice
f = f.replace(
  '        <div className="player-controls-hint"><span>Space: play/pause · F: fullscreen · M: mute · ↑↓: volume · ←→: seek</span></div>\n      {error',
  '        <div className="player-controls-hint"><span>Space: play/pause · F: fullscreen · M: mute · ↑↓: volume · ←→: seek</span></div>\n      </div>\n      {error'
);

// Fix 5: Final closing - add missing </div> before );
f = f.replace(
  '      </div>\n  );\n}',
  '      </div>\n    </div>\n  );\n}'
);

fs.writeFileSync('web/src/components/dashboard/stream-player.tsx', f);
console.log('Fixed stream-player.tsx');
