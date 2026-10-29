import { Fragment } from 'react';

// The liquid glass lens (app/liquid-glass.css): one SVG filter per panel shape, referenced by backdrop-filter: url(#lg-*). Each bends what
// is behind the panel only near its edge (public/glass/disp-*.png: a rounded-rect bezel map, neutral in the middle, so the centre stays
// sharp) and splits red, green and blue by slightly different amounts for the faint colour fringe at the rim. Chromium only; elsewhere
// the url() is ignored and the blur and rim remain.
const SHAPES = [['tall', 46], ['wide', 40], ['tile', 30]] as const;
const CHANNEL = ['1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0', '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0'];

export function GlassDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
      {SHAPES.map(([shape, scale]) => (
        <filter key={shape} id={`lg-${shape}`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feImage href={`/glass/disp-${shape}.png`} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
          {CHANNEL.map((m, i) => (
            <Fragment key={i}>
              <feDisplacementMap in="SourceGraphic" in2="map" scale={scale - i * 4} xChannelSelector="R" yChannelSelector="G" result={`d${i}`} />
              <feColorMatrix in={`d${i}`} type="matrix" values={m} result={`c${i}`} />
            </Fragment>
          ))}
          <feBlend in="c0" in2="c1" mode="screen" result="rg" />
          <feBlend in="rg" in2="c2" mode="screen" />
        </filter>
      ))}
    </svg>
  );
}
