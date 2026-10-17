/** Original monochrome artwork for the compact, classic HUD touch controls. */
const icons={
 crouch:'<path d="M13 5a3 3 0 1 0 6 0 3 3 0 0 0-6 0M12 4.5c0-5 8-5 8 0h1v1.3H11V4.5zM13 9h5l3 4 7-1 1 2-9 3-4-4-3 3 8 2 1 5h7v3H19l-2-6-6-1-4 4h6v3H2v-3l6-7zM23 9h14v1.5h-8l-4 2h-3z"/>',
 prone:'<path d="M25 15a3 3 0 1 0 6 0 3 3 0 0 0-6 0M24 14.5c0-4.5 8-4.5 8 0h1v1.2H23v-1.2zM10 18l11-2 6 3 6-1 1 2-7 2-7-3-8 3-9 2H1v-3l8-2-7-1v-2zM28 12h12v1.5h-7l-3 2h-3z"/>',
 aim:'<g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 23V13a10 10 0 0 1 20 0v10M20 24V12m-3 0h6M6 23h28"/></g>',
 reload:'<path d="M11 24V13l2-4 2 4v11zm7 0V13l2-4 2 4v11zm7 0V13l2-4 2 4v11z"/><path d="M33 12A13 13 0 0 0 8 10m-3-5 2 6 6-2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
};
export function touchActionIcon(action:keyof typeof icons){return `<svg class="touch-action-icon" viewBox="0 0 40 28" fill="currentColor" aria-hidden="true" focusable="false">${icons[action]}</svg>`;}
