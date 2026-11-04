const SITE_VISUALS = [
    {
        slug: 'mandelbulb',
        url: 'vr/mandelbulb.html',
        title: 'Mandelbulb',
        description: 'A raymarched, time-mutating Mandelbulb fractal. Scrub, rewind and fast-forward its evolution from inside it.'
    },
    {
        slug: 'root',
        url: 'vr/root-vr.html',
        title: 'ROOT VR',
        description: "UCLA's ROOT VR plotting client, its Unity shaders compiled to WebGL. Walk around 2D histograms, scatter graphs and 4D VRGraph3D plots, zoom in on Earth through 3,000 real stars, or drop in your own ROOT data."
    },
    {
        slug: 'universe-vr',
        url: 'vr/universe-vr.html',
        title: 'UniverseVR',
        description: "Markus Lipp's Oculus DK2 demo, rebuilt for WebXR from its shaders. Fly through 849,274 galaxies from the Millennium Simulation, rendered as glowing sprites and colour-mapped as the original did."
    },
    {
        slug: 'field-lines',
        url: 'vr/field-lines.html',
        title: 'VR Field Lines',
        description: 'The Quest field-lines app in the browser: preset and drag-around point charges, a point charge near the speed of light, parallel wires and a current loop, with lines traced from Coulomb and Biot–Savart.'
    },
    {
        slug: 'g4xr',
        url: 'vr/g4xr.html',
        title: 'G4Xr',
        description: "A WebXR viewer for UCLA's G4Xr Geant4 driver. Walk round a detector and replay its trajectories step by step, or drop in your own trial.glb, run.bin or session zip."
    },
    {
        slug: 'cms-events',
        url: 'vr/cms-events.html',
        title: 'CMS Events',
        description: 'Real 2011 CMS collisions around a life-size CMS detector. Watch muons bend out through the drift tubes and cathode strip chambers, and find the Z, the W and the top quark in the mass plots.'
    },
    {
        slug: 'relativity',
        url: 'vr/relativity.html',
        title: 'Relativistic Flythrough',
        description: 'Fly at up to 99.8% of the speed of light. Aberration bends a field of pillars and globes into a cone ahead, the Doppler shift turns it blue in front and amber behind, and beaming floods the view.'
    },
];

function siteVisualUrl(path, rootPrefix) {
    return /^https?:\/\//.test(path) ? path : rootPrefix + path;
}

/* vr/index.html's directory of every visual, laid out like index.html's blog list */
function renderVisualList(containerSelector, rootPrefix) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    SITE_VISUALS.forEach(visual => {
        const a = document.createElement('a');
        a.href = siteVisualUrl(visual.url, rootPrefix);

        const article = document.createElement('article');

        const path = document.createElement('span');
        path.className = 'path';
        path.textContent = '/' + visual.url;
        article.appendChild(path);

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = visual.title;
        article.appendChild(title);

        const description = document.createElement('span');
        description.className = 'description';
        description.textContent = visual.description;
        article.appendChild(description);

        a.appendChild(article);
        container.appendChild(a);
    });
}
