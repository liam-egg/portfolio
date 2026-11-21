/* Every visual on /vr, in the order vr/index.html lists them. Credit, as the hub shows it:
     no `author`                  "original": made for this site
     `author`                     "port · <author>": someone else's VR project rebuilt for the browser
     `author` + `extended: true`  "based on · <author>": a port grown well past the original (new data,
                                  new modes); the page itself credits what was added
   Data credits (catalogues, simulations, music) belong on the scene's own page, next to the data, not
   here: universe-vr.html reads each dataset's credit from vr/universe-vr/datasets.json. */
const SITE_VISUALS = [
    {
        slug: 'fractals',
        url: 'vr/fractals.html',
        title: '3D Fractals',
        description: 'Raymarched, time-mutating 3D fractals: the Mandelbulb, a quaternion Julia set and a 3D Burning Ship. Scrub, rewind and fast-forward their evolution from inside them.'
    },
    {
        slug: 'universe-vr',
        url: 'vr/universe-vr.html',
        title: 'UniverseVR',
        author: 'Markus Lipp',
        extended: true,
        description: "An Oculus DK2 demo, rebuilt for WebXR from its shaders. Fly through 849,274 galaxies from the Millennium Simulation, or switch to the real sky: the CfA surveys that found the Great Wall and 221,410 galaxies of the 2dF survey, all drawn to one scale."
    },
    {
        slug: 'root',
        url: 'vr/root-vr.html',
        title: 'ROOT VR',
        author: 'Aryan M-Pour',
        description: "UCLA's ROOT VR plotting client, its Unity shaders compiled to WebGL. Walk around 2D histograms, scatter graphs and 4D VRGraph3D plots, zoom in on Earth through 3,000 real stars, or drop in your own ROOT data."
    },
    {
        slug: 'relativity',
        url: 'vr/relativity.html',
        title: 'Relativistic Flythrough',
        description: 'Fly at up to 99.8% of the speed of light. Aberration bends a field of pillars and globes into a cone ahead, the Doppler shift turns it blue in front and amber behind, and beaming floods the view.'
    },
    {
        slug: 'qcd-flux-tubes',
        url: 'vr/qcd-flux-tubes.html',
        title: 'QCD Flux Tubes',
        description: "Grab a quark and antiquark and pull them apart. The colour field squeezes into a flux tube whose energy grows with length until the string snaps into new mesons. Compare an electric dipole's spreading field, or stretch a baryon's Y-shaped string."
    },
    {
        slug: 'g4xr',
        url: 'vr/g4xr.html',
        title: 'G4Xr',
        author: 'Benjamin Jobilal',
        description: "A WebXR viewer for UCLA's G4Xr Geant4 driver. Walk round a detector and replay its trajectories step by step, or drop in your own trial.glb, run.bin or session zip."
    },
    {
        slug: 'cms-events',
        url: 'vr/cms-events.html',
        title: 'CMS Events',
        description: 'Real 2011 CMS collisions around a life-size CMS detector. Watch muons bend out through the drift tubes and cathode strip chambers, and find the Z, the W and the top quark in the mass plots.'
    },
    {
        slug: 'field-lines',
        url: 'vr/field-lines.html',
        title: 'VR Field Lines',
        author: 'Rin Fudemberg',
        description: 'The Quest field-lines app in the browser: preset and drag-around point charges, a point charge near the speed of light, parallel wires and a current loop, with lines traced from Coulomb and Biot–Savart.'
    },
];

function siteVisualUrl(path, rootPrefix) {
    return /^https?:\/\//.test(path) ? path : rootPrefix + path;
}

/* vr/index.html's directory of every visual, laid out like index.html's blog list: the path and who
   made it in a mono column, a rule, then the title and description */
function renderVisualList(containerSelector, rootPrefix) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    SITE_VISUALS.forEach(visual => {
        const a = document.createElement('a');
        a.href = siteVisualUrl(visual.url, rootPrefix);

        const article = document.createElement('article');

        const meta = document.createElement('span');
        meta.className = 'meta';
        const path = document.createElement('span');
        path.className = 'path';
        path.textContent = '/' + visual.url;
        const origin = document.createElement('span');
        origin.className = visual.author ? 'origin port' : 'origin';
        origin.textContent = !visual.author ? 'original' : `${visual.extended ? 'based on' : 'port'} · ${visual.author}`;
        meta.append(path, origin);
        article.appendChild(meta);

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
