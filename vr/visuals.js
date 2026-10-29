const SITE_VISUALS = [
    {
        slug: 'mandelbulb',
        url: 'vr/mandelbulb.html',
        title: 'Mandelbulb',
        description: 'A raymarched, time-mutating Mandelbulb fractal. Scrub, rewind and fast-forward its evolution from inside it.'
    },
    {
        slug: 'root',
        url: 'vr/root.html',
        title: 'ROOT VR',
        description: "UCLA's ROOT VR plotting client, its Unity shaders compiled to WebGL. Walk around 2D histograms, scatter graphs and 4D VRGraph3D plots, zoom in on Earth through 3,000 real stars, or drop in your own ROOT data."
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
