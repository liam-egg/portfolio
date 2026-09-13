const SITE_POSTS = [
    {
        slug: 'lagrangian-mechanics',
        url: 'posts/lagrangian-mechanics.html',
        title: 'Lagrangian Mechanics from the Ground Up',
        description: "Deriving the Euler–Lagrange equation from Newton's laws and introductory calculus, then putting it to work on the simple pendulum — and, one level up, on light bending around a black hole.",
        thumbnail: 'images/geodesic-lagrangian.png',
        tags: ['physics', 'pendulum'],
        date: '[9-09-2026]'
    },
    {
        slug: 'double-pendulum',
        url: 'posts/double-pendulum.html',
        title: 'Simulating the Double Pendulum',
        description: 'An examination of chaos through the lens of Lagrangian mechanics — from coupled equations of motion to a from-scratch Euler integrator.',
        thumbnail: 'images/dp-fractal.png',
        tags: ['physics', 'lagrangian mechanics', 'math'],
        date: '[9-10-2026]'
    },
    {
        slug: 'runge-kutta',
        url: 'posts/runge-kutta.html',
        title: 'RK4: Understanding the Universe',
        description: "Why Euler's method drifts, and how sampling the slope four times a step buys back the accuracy to trust a simulation again.",
        thumbnail: 'images/rk4.png',
        tags: ['physics', 'lagrangian mechanics', 'math'],
        date: '[9-11-2026]'
    },
    {
        slug: 'pid',
        url: 'posts/pid.html',
        title: 'PID: The Balance of Things',
        description: 'Closing the loop on the pendulum simulations with proportional-integral-derivative control, from a single tuned gain to a live map of every tuning at once.',
        thumbnail: 'images/pid-gain.png',
        tags: ['physics', 'lagrangian mechanics', 'math'],
        date: '[9-12-2026]'
    },
    // {
    //     slug: 'dip-balancing',
    //     url: 'blog.html',
    //     title: 'Balancing a Double Inverted Pendulum',
    //     description: 'A carriage system and a reinforcement learning policy built to stabilize an underactuated system that would really rather fall over.',
    //     thumbnail: 'https://images.ctfassets.net/3njn2qm7rrbs/4G1rFSnNpB7SLiagppyuPk/1533f0b3c698a10190149c77bd4c375a/planning-in-the-dark_2x.png?w=2000',
    //     tags: ['control systems', 'physics'],
    //     comingSoon: true
    // },
    // {
    //     slug: 'cloud-chamber',
    //     url: 'blog.html',
    //     title: 'Building a Cloud Chamber From a Fly Swatter',
    //     description: 'Ionizing air with a glass canister and a high-voltage transformer, and watching real atomic decay leave visible trails.',
    //     thumbnail: 'https://images.ctfassets.net/3njn2qm7rrbs/4G1rFSnNpB7SLiagppyuPk/1533f0b3c698a10190149c77bd4c375a/planning-in-the-dark_2x.png?w=500',
    //     tags: ['physics', 'hardware'],
    //     comingSoon: true
    // }
];

function siteAssetUrl(path, rootPrefix) {
    return /^https?:\/\//.test(path) ? path : rootPrefix + path;
}

/* blog.html's full, filterable post directory — includes comingSoon entries */
function renderPostGrid(containerSelector, rootPrefix) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    SITE_POSTS.forEach(post => {
        const a = document.createElement('a');
        a.href = siteAssetUrl(post.url, rootPrefix);
        a.dataset.tags = post.tags.join(',');

        const article = document.createElement('article');

        const img = document.createElement('img');
        img.src = siteAssetUrl(post.thumbnail, rootPrefix);
        img.alt = '';
        article.appendChild(img);
        article.appendChild(document.createElement('hr'));

        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = post.comingSoon ? 'coming soon' : post.tags.join(' · ');
        article.appendChild(label);

        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = post.title;
        article.appendChild(text);

        const description = document.createElement('span');
        description.className = 'description';
        description.textContent = post.description;
        article.appendChild(description);

        a.appendChild(article);
        container.appendChild(a);
    });
}

/* index.html's brief teaser list — real posts only, most recent first, capped at `limit` */
function renderBlogPreview(containerSelector, rootPrefix, limit) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    const posts = SITE_POSTS.filter(post => !post.comingSoon).slice(-limit).reverse();

    posts.forEach(post => {
        const a = document.createElement('a');
        a.href = siteAssetUrl(post.url, rootPrefix);

        const article = document.createElement('article');

        const date = document.createElement('span');
        date.className = 'date';
        date.textContent = post.date || '';
        article.appendChild(date);

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = post.title;
        article.appendChild(title);

        const description = document.createElement('span');
        description.className = 'description';
        description.textContent = post.description;
        article.appendChild(description);

        const tagRow = document.createElement('div');
        post.tags.forEach(tag => {
            const span = document.createElement('span');
            span.textContent = tag;
            tagRow.appendChild(span);
        });
        article.appendChild(tagRow);

        a.appendChild(article);
        container.appendChild(a);
    });
}

/* the "read next" pair at the bottom of a post page — the next post in reading order, plus a link back to the blog */
function renderReadNext(containerSelector, rootPrefix) {
    const container = document.querySelector(containerSelector);
    if (!container) return;

    const published = SITE_POSTS.filter(post => !post.comingSoon);
    const slug = location.pathname.split('/').pop().replace(/\.html$/, '');
    const currentIndex = published.findIndex(post => post.slug === slug);
    const next = currentIndex > -1 ? published[currentIndex + 1] : undefined;

    const makeCard = (url, thumbnail, title, description) => {
        const a = document.createElement('a');
        a.href = siteAssetUrl(url, rootPrefix);

        const article = document.createElement('article');

        const img = document.createElement('img');
        img.src = siteAssetUrl(thumbnail, rootPrefix);
        img.alt = '';
        article.appendChild(img);
        article.appendChild(document.createElement('hr'));

        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = title;
        article.appendChild(text);

        const description_ = document.createElement('span');
        description_.className = 'description';
        description_.textContent = description;
        article.appendChild(description_);

        a.appendChild(article);
        return a;
    };

    if (next) container.appendChild(makeCard(next.url, next.thumbnail, next.title, next.description));
    container.appendChild(makeCard(
        'blog.html',
        'images/black-hole.png',
        'More writing',
        'Browse the rest of the blog for more on physics, math, and computation.'
    ));
}
