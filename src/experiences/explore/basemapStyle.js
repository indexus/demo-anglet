// Local style snapshot; only the independent tiles/fonts/sprites are fetched online.
import style from './basemap-dark.json' with {type:'json'};
export function localBasemapStyle(){return structuredClone(style);}
