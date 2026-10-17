/** Unmodified Lucide icon geometry, vendored from lucide-icons/lucide at
 * 1ef60af944de207e0d5176905a0759ba12e6ee8d. ISC / Feather MIT notices are in
 * public/THIRD_PARTY_LICENSES.txt; icon sources are listed in research/ui-reference.md. */
const icons={
 crouch:{name:'chevron-down',body:'<path d="m6 9 6 6 6-6"/>'},
 prone:{name:'chevrons-down',body:'<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>'},
 aim:{name:'crosshair',body:'<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>'},
 reload:{name:'rotate-cw',body:'<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'},
 fire:{name:'circle-dot',body:'<circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="10"/>'},
};
export function touchActionIcon(action:keyof typeof icons){
 const {name,body}=icons[action];
 return `<svg class="touch-action-icon lucide lucide-${name}" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
