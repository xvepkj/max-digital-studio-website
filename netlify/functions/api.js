const { Octokit } = require("@octokit/rest");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function getOctokit() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }
  return new Octokit({ auth: token });
}

function getRepoInfo() {
  return {
    owner: process.env.GITHUB_OWNER || "xvepkj",
    repo: process.env.GITHUB_REPO || "max-digital-studio-website",
  };
}

// Map display category names to directory names used on disk.
const CATEGORY_DIR_MAP = {
  wedding: "wedding",
  "pre-wedding": "pre_wedding",
  sagan: "sagan",
};

function categoryToDir(category) {
  return CATEGORY_DIR_MAP[category] || category;
}

// Map page names to HTML filenames
const PAGE_FILE_MAP = {
  home: "index.html",
  about: "about.html",
  events: "events.html",
  contact: "contact.html",
  services: "services.html",
  gallery: "gallery.html",
};

// Reverse map: directory name -> CSS filter class name
const DIR_TO_CATEGORY_MAP = {
  wedding: "wedding",
  pre_wedding: "pre-wedding",
  sagan: "sagan",
};

function dirToCategory(dir) {
  return DIR_TO_CATEGORY_MAP[dir] || dir;
}

// ---------------------------------------------------------------------------
// Cloudinary helpers
// ---------------------------------------------------------------------------

function getCloudinaryConfig() {
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET,
  };
}

// ---------------------------------------------------------------------------
// GitHub file helpers
// ---------------------------------------------------------------------------

async function getFileContent(octokit, owner, repo, path) {
  const { data } = await octokit.repos.getContent({ owner, repo, path });
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha };
}

async function updateFile(octokit, owner, repo, path, content, message, sha) {
  // If no sha provided, fetch it first
  let currentSha = sha;
  if (!currentSha) {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path });
      currentSha = data.sha;
    } catch (err) {
      // File does not exist yet; createOrUpdateFileContents handles creation
      currentSha = undefined;
    }
  }

  const params = {
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content).toString("base64"),
  };
  if (currentSha) {
    params.sha = currentSha;
  }

  await octokit.repos.createOrUpdateFileContents(params);
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

// 1. list-images -----------------------------------------------------------
async function handleListImages(queryParams) {
  const category = queryParams.category;
  if (!category) {
    return response(400, { error: "Missing required query parameter: category" });
  }

  const catDir = categoryToDir(category);
  const thumbDir = `img/thumbs/${catDir}`;
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: thumbDir,
    });

    if (!Array.isArray(data)) {
      return response(400, { error: `${thumbDir} is not a directory` });
    }

    const images = data
      .filter((item) => item.type === "file")
      .map((item) => ({
        name: item.name,
        path: `${thumbDir}/${item.name}`,
        sha: item.sha,
        thumbUrl: `img/thumbs/${catDir}/${item.name}`,
        fullUrl: `img/${catDir}/${item.name}`,
      }));

    return response(200, images);
  } catch (err) {
    if (err.status === 404) {
      return response(404, { error: `Category directory not found: ${thumbDir}` });
    }
    throw err;
  }
}

// 2. rotate-image ----------------------------------------------------------
async function handleRotateImage(body) {
  const { category, filename, thumbData, fullData } = body;

  if (!category || !filename || !thumbData) {
    return response(400, {
      error: "Missing required fields: category, filename, thumbData",
    });
  }

  const catDir = categoryToDir(category);
  const thumbPath = `img/thumbs/${catDir}/${filename}`;
  const commitMessage = `Rotate ${filename} via admin panel`;

  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  // Strip data URI prefix if present (e.g. "data:image/webp;base64,...")
  const cleanBase64 = (data) => {
    if (data.includes(",")) {
      return data.split(",")[1];
    }
    return data;
  };

  // Get current SHA for the thumbnail
  let thumbSha;
  try {
    const thumbInfo = await octokit.repos.getContent({ owner, repo, path: thumbPath });
    thumbSha = thumbInfo.data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  // Update thumbnail
  const thumbParams = {
    owner,
    repo,
    path: thumbPath,
    message: commitMessage,
    content: cleanBase64(thumbData),
  };
  if (thumbSha) thumbParams.sha = thumbSha;
  await octokit.repos.createOrUpdateFileContents(thumbParams);

  // Optionally update full-size image (if provided and within payload limits)
  if (fullData) {
    const fullPath = `img/${catDir}/${filename}`;
    let fullSha;
    try {
      const fullInfo = await octokit.repos.getContent({ owner, repo, path: fullPath });
      fullSha = fullInfo.data.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const fullParams = {
      owner,
      repo,
      path: fullPath,
      message: commitMessage,
      content: cleanBase64(fullData),
    };
    if (fullSha) fullParams.sha = fullSha;
    await octokit.repos.createOrUpdateFileContents(fullParams);
  }

  return response(200, { success: true });
}

// 3. get-gallery -----------------------------------------------------------
async function handleGetGallery() {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const { content } = await getFileContent(octokit, owner, repo, "gallery.html");

  // Parse gf-item divs from the gallery HTML
  const itemRegex =
    /<div\s+class="gf-item\s+set-bg\s+([^"]*?)\s+lazy(?:\s+([^"]*?))?\s*"\s+data-bg="([^"]+)"\s*>/g;

  const items = [];
  let match;
  while ((match = itemRegex.exec(content)) !== null) {
    const classesRaw = match[1].trim();
    const heightClass = match[2] ? match[2].trim() : "";
    const dataBg = match[3];

    // classesRaw is the category CSS class (e.g. "wedding", "pre-wedding", "sagan")
    const category = classesRaw;

    // Extract filename from path like "img/thumbs/wedding/wedding_1.webp"
    const parts = dataBg.split("/");
    const filename = parts[parts.length - 1];
    const catDir = parts.length >= 3 ? parts[2] : categoryToDir(category);

    items.push({
      category,
      filename,
      thumbPath: dataBg,
      fullPath: `img/${catDir}/${filename}`,
      height: heightClass || "",
    });
  }

  return response(200, items);
}

// 4. update-gallery --------------------------------------------------------
async function handleUpdateGallery(body) {
  const { items } = body;

  if (!items || !Array.isArray(items)) {
    return response(400, { error: "Missing required field: items (array)" });
  }

  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const { content: html, sha } = await getFileContent(
    octokit,
    owner,
    repo,
    "gallery.html"
  );

  // Normalize items: accept either path strings or {category, filename, height} objects
  const normalizedItems = items.map((item) => {
    if (typeof item === "string") {
      // Path like "img/thumbs/wedding/wedding_1.webp"
      const parts = item.split("/");
      const filename = parts[parts.length - 1];
      const catDirName = parts.length >= 3 ? parts[parts.length - 2] : "";
      return {
        category: dirToCategory(catDirName),
        catDir: catDirName,
        filename,
        height: "",
      };
    }
    return {
      ...item,
      catDir: categoryToDir(item.category),
    };
  });

  // Build new gallery items HTML
  const itemsHtml = normalizedItems
    .map((item) => {
      const catDir = item.catDir || categoryToDir(item.category);
      const heightClass = item.height ? ` ${item.height}` : "";
      return [
        `                        <div class="gf-item set-bg ${item.category} lazy${heightClass}" data-bg="img/thumbs/${catDir}/${item.filename}">`,
        `                            <a href="img/${catDir}/${item.filename}" class="gf-icon image-popup"><span class="icon_zoom-in_alt"></span></a>`,
        `                        </div>`,
      ].join("\n");
    })
    .join("\n\n");

  // Replace the content inside <div class="gallery-filter"> ... </div>
  const galleryFilterRegex =
    /(<div\s+class="gallery-filter">\s*)([\s\S]*?)(\s*<\/div>\s*<!-- gallery-filter end -->|(?=\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<!-- Gallery Section End -->))/;

  // More robust approach: find gallery-filter opening and its matching content
  const openTag = '<div class="gallery-filter">';
  const openIdx = html.indexOf(openTag);
  if (openIdx === -1) {
    return response(500, { error: "Could not find gallery-filter div in gallery.html" });
  }

  const contentStart = openIdx + openTag.length;

  // Find the closing </div> that matches the gallery-filter div
  // We need to count nested divs to find the correct closing tag
  let depth = 1;
  let i = contentStart;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) {
        // Found the matching closing tag
        const newHtml =
          html.substring(0, contentStart) +
          "\n" +
          itemsHtml +
          "\n" +
          html.substring(nextClose);

        await updateFile(
          octokit,
          owner,
          repo,
          "gallery.html",
          newHtml,
          "Update gallery via admin panel",
          sha
        );

        return response(200, { success: true });
      }
      i = nextClose + 6;
    }
  }

  return response(500, {
    error: "Could not parse gallery-filter div structure in gallery.html",
  });
}

// 5. get-content -----------------------------------------------------------
async function handleGetContent(queryParams) {
  const page = queryParams.page;
  if (!page) {
    return response(400, { error: "Missing required query parameter: page" });
  }

  const filename = PAGE_FILE_MAP[page] || `${page}.html`;
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  let htmlContent;
  try {
    const result = await getFileContent(octokit, owner, repo, filename);
    htmlContent = result.content;
  } catch (err) {
    if (err.status === 404) {
      return response(404, { error: `Page not found: ${filename}` });
    }
    throw err;
  }

  const parsed = {};

  if (page === "home") {
    // Parse hero slide images (data-setbg on .hs-item)
    const heroImages = [];
    const heroImgRegex = /<div\s+class="hs-item\s+set-bg"\s+data-setbg="([^"]+)"/g;
    let heroImgMatch;
    while ((heroImgMatch = heroImgRegex.exec(htmlContent)) !== null) {
      heroImages.push(heroImgMatch[1].trim());
    }
    parsed.heroImages = heroImages;

    // Parse hero slides text
    const heroSlides = [];
    const slideRegex =
      /<div\s+class="hs-item\s+set-bg"[^>]*>[\s\S]*?<h2>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g;
    let slideMatch;
    while ((slideMatch = slideRegex.exec(htmlContent)) !== null) {
      heroSlides.push({
        heading: slideMatch[1].trim(),
        text: slideMatch[2].trim(),
      });
    }
    parsed.heroSlides = heroSlides;

    // Parse service cards
    const services = [];
    const serviceRegex =
      /<div\s+class="services-item">\s*<a[^>]*>\s*<img\s+src="([^"]+)"[^>]*>\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g;
    let serviceMatch;
    while ((serviceMatch = serviceRegex.exec(htmlContent)) !== null) {
      services.push({
        image: serviceMatch[1].trim(),
        title: serviceMatch[2].trim(),
        description: serviceMatch[3].trim(),
      });
    }
    parsed.services = services;

    // Parse portfolio items as array of thumb paths
    const portfolioImages = [];
    const pfRegex =
      /<div\s+class="pf-item[^"]*"\s+data-setbg="([^"]+)"/g;
    let pfMatch;
    while ((pfMatch = pfRegex.exec(htmlContent)) !== null) {
      portfolioImages.push(pfMatch[1].trim());
    }
    parsed.portfolioImages = portfolioImages;
  } else if (page === "about") {
    // Parse section title and description
    const titleMatch = htmlContent.match(
      /<div\s+class="section-title">\s*<h2>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>/
    );
    if (titleMatch) {
      parsed.title = titleMatch[1].trim();
      parsed.description = titleMatch[2].trim();
    }

    // Parse feature list items
    const features = [];
    const liRegex =
      /<div\s+class="al-text">\s*<h5>([\s\S]*?)<\/h5>\s*<p>([\s\S]*?)<\/p>/g;
    let liMatch;
    while ((liMatch = liRegex.exec(htmlContent)) !== null) {
      features.push({
        title: liMatch[1].trim(),
        description: liMatch[2].trim(),
      });
    }
    parsed.features = features;
  } else if (page === "events") {
    // Parse event cards: .services-item elements with <a> containing <img> and <h3>
    const eventCards = [];
    const cardRegex =
      /<div\s+class="services-item">\s*<a\s+href="([^"]+)"[^>]*>\s*<img\s+src="([^"]+)"[^>]*>\s*<h3>([\s\S]*?)<\/h3>/g;
    let cardMatch;
    while ((cardMatch = cardRegex.exec(htmlContent)) !== null) {
      eventCards.push({
        title: cardMatch[3].trim(),
        image: cardMatch[2].trim(),
        link: cardMatch[1].trim(),
      });
    }
    parsed.eventCards = eventCards;

    // Parse event descriptions: .so-item elements with .so-title h5 and <p>
    const eventDescs = [];
    const descRegex =
      /<div\s+class="so-item">\s*<div\s+class="so-title">\s*<div\s+class="so-number">[^<]*<\/div>\s*<h5>([\s\S]*?)<\/h5>\s*<\/div>\s*<p>([\s\S]*?)<\/p>/g;
    let descMatch;
    while ((descMatch = descRegex.exec(htmlContent)) !== null) {
      eventDescs.push({
        title: descMatch[1].trim(),
        description: descMatch[2].trim(),
      });
    }
    parsed.eventDescs = eventDescs;
  } else if (page === "contact") {
    // Parse address
    const addrMatch = htmlContent.match(
      /<div\s+class="ct-text">\s*<h5>Address<\/h5>\s*<p>([\s\S]*?)<\/p>/
    );
    if (addrMatch) parsed.address = addrMatch[1].trim();

    // Parse phone (uses <ul><li>)
    const phoneMatch = htmlContent.match(
      /<div\s+class="ct-text">\s*<h5>Phone<\/h5>\s*<ul>\s*<li>([\s\S]*?)<\/li>/
    );
    if (phoneMatch) parsed.phone = phoneMatch[1].trim();

    // Parse email
    const emailMatch = htmlContent.match(
      /<div\s+class="ct-text">\s*<h5>Email<\/h5>\s*<p>([\s\S]*?)<\/p>/
    );
    if (emailMatch) parsed.email = emailMatch[1].trim();
  }

  return response(200, parsed);
}

// 6. update-content --------------------------------------------------------
async function handleUpdateContent(body) {
  const { page, content: updates } = body;

  if (!page || !updates) {
    return response(400, { error: "Missing required fields: page, content" });
  }

  const filename = PAGE_FILE_MAP[page] || `${page}.html`;
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  let html, sha;
  try {
    const result = await getFileContent(octokit, owner, repo, filename);
    html = result.content;
    sha = result.sha;
  } catch (err) {
    if (err.status === 404) {
      return response(404, { error: `Page not found: ${filename}` });
    }
    throw err;
  }

  if (page === "home") {
    // Update hero slides text
    if (updates.heroSlides && Array.isArray(updates.heroSlides)) {
      let slideIndex = 0;
      html = html.replace(
        /(<div\s+class="hs-text">\s*<h2>)([\s\S]*?)(<\/h2>\s*<p>)([\s\S]*?)(<\/p>)/g,
        (match, before_h2, _oldTitle, between, _oldDesc, after_p) => {
          if (slideIndex < updates.heroSlides.length) {
            const slide = updates.heroSlides[slideIndex];
            slideIndex++;
            return (
              before_h2 +
              (slide.heading || _oldTitle) +
              between +
              (slide.text || _oldDesc) +
              after_p
            );
          }
          return match;
        }
      );
    }

    // Update hero images (data-setbg on .hs-item divs)
    if (updates.heroImages && Array.isArray(updates.heroImages)) {
      let heroIndex = 0;
      html = html.replace(
        /(<div\s+class="hs-item\s+set-bg"\s+data-setbg=")([^"]*?)(")/g,
        (match, pre, _oldPath, post) => {
          if (heroIndex < updates.heroImages.length) {
            const newPath = updates.heroImages[heroIndex];
            heroIndex++;
            return pre + newPath + post;
          }
          return match;
        }
      );
    }

    // Update service cards
    if (updates.services && Array.isArray(updates.services)) {
      let svcIndex = 0;
      html = html.replace(
        /(<div\s+class="services-item">\s*<a[^>]*>\s*<img\s+src=")([^"]+)("[^>]*>\s*<h3>)([\s\S]*?)(<\/h3>\s*<p>)([\s\S]*?)(<\/p>)/g,
        (match, pre_img, _oldImg, post_img, _oldTitle, between, _oldDesc, after) => {
          if (svcIndex < updates.services.length) {
            const svc = updates.services[svcIndex];
            svcIndex++;
            return (
              pre_img +
              (svc.image || _oldImg) +
              post_img +
              (svc.title || _oldTitle) +
              between +
              (svc.description || _oldDesc) +
              after
            );
          }
          return match;
        }
      );
    }

    // Update portfolio images (rebuild pf-item divs inside .portfolio-filter)
    if (updates.portfolioImages && Array.isArray(updates.portfolioImages)) {
      const pfItemsHtml = updates.portfolioImages
        .map((thumbPath) => {
          // thumbPath like "img/thumbs/wedding/wedding_1.webp"
          const parts = thumbPath.split("/");
          const filename = parts[parts.length - 1];
          const catDirName = parts.length >= 3 ? parts[2] : "";
          const catClass = dirToCategory(catDirName);
          const fullPath = `img/${catDirName}/${filename}`;
          return [
            `                        <div class="pf-item col-6 col-sm-6 col-lg-4 set-bg ${catClass}" data-setbg="${thumbPath}">`,
            `                            <a href="${fullPath}" class="pf-icon image-popup"><span class="icon_zoom-in_alt"></span></a>`,
            `                        </div>`,
          ].join("\n");
        })
        .join("\n");

      // Find portfolio-filter div and replace its content
      const pfOpenTag = '<div class="portfolio-filter">';
      const pfOpenIdx = html.indexOf(pfOpenTag);
      if (pfOpenIdx !== -1) {
        const pfContentStart = pfOpenIdx + pfOpenTag.length;
        let pfDepth = 1;
        let pfI = pfContentStart;
        while (pfI < html.length && pfDepth > 0) {
          const pfNextOpen = html.indexOf("<div", pfI);
          const pfNextClose = html.indexOf("</div>", pfI);
          if (pfNextClose === -1) break;
          if (pfNextOpen !== -1 && pfNextOpen < pfNextClose) {
            pfDepth++;
            pfI = pfNextOpen + 4;
          } else {
            pfDepth--;
            if (pfDepth === 0) {
              html =
                html.substring(0, pfContentStart) +
                "\n" +
                pfItemsHtml +
                "\n                    " +
                html.substring(pfNextClose);
            }
            pfI = pfNextClose + 6;
          }
        }
      }
    }
  } else if (page === "about") {
    // Update section title and description
    if (updates.title !== undefined || updates.description !== undefined) {
      html = html.replace(
        /(<div\s+class="section-title">\s*<h2>)([\s\S]*?)(<\/h2>\s*<p>)([\s\S]*?)(<\/p>)/,
        (match, pre_h2, oldTitle, between, oldDesc, after) => {
          return (
            pre_h2 +
            (updates.title !== undefined ? updates.title : oldTitle) +
            between +
            (updates.description !== undefined ? updates.description : oldDesc) +
            after
          );
        }
      );
    }

    // Update feature list items
    if (updates.features && Array.isArray(updates.features)) {
      let liIndex = 0;
      html = html.replace(
        /(<div\s+class="al-text">\s*<h5>)([\s\S]*?)(<\/h5>\s*<p>)([\s\S]*?)(<\/p>)/g,
        (match, pre_h5, oldTitle, between, oldDesc, after) => {
          if (liIndex < updates.features.length) {
            const item = updates.features[liIndex];
            liIndex++;
            return (
              pre_h5 +
              (item.title || oldTitle) +
              between +
              (item.description || oldDesc) +
              after
            );
          }
          return match;
        }
      );
    }
  } else if (page === "events") {
    // Update event card titles (<h3> inside .services-item)
    if (updates.eventCards && Array.isArray(updates.eventCards)) {
      let cardIndex = 0;
      html = html.replace(
        /(<div\s+class="services-item">[\s\S]*?<h3>)([\s\S]*?)(<\/h3>)/g,
        (match, pre, _oldTitle, post) => {
          if (cardIndex < updates.eventCards.length) {
            const card = updates.eventCards[cardIndex];
            cardIndex++;
            return pre + (card.title || _oldTitle) + post;
          }
          return match;
        }
      );
    }

    // Update event descriptions (.so-item blocks)
    if (updates.eventDescs && Array.isArray(updates.eventDescs)) {
      let descIndex = 0;
      html = html.replace(
        /(<div\s+class="so-item">\s*<div\s+class="so-title">\s*<div\s+class="so-number">[^<]*<\/div>\s*<h5>)([\s\S]*?)(<\/h5>\s*<\/div>\s*<p>)([\s\S]*?)(<\/p>)/g,
        (match, pre_h5, _oldTitle, between, _oldDesc, after) => {
          if (descIndex < updates.eventDescs.length) {
            const desc = updates.eventDescs[descIndex];
            descIndex++;
            return (
              pre_h5 +
              (desc.title || _oldTitle) +
              between +
              (desc.description || _oldDesc) +
              after
            );
          }
          return match;
        }
      );
    }
  } else if (page === "contact") {
    // Update contact info fields
    if (updates.address !== undefined) {
      html = html.replace(
        /(<div\s+class="ct-text">\s*<h5>Address<\/h5>\s*<p>)([\s\S]*?)(<\/p>)/,
        (match, pre, _old, post) => pre + updates.address + post
      );
    }
    if (updates.phone !== undefined) {
      html = html.replace(
        /(<div\s+class="ct-text">\s*<h5>Phone<\/h5>\s*<ul>\s*<li>)([\s\S]*?)(<\/li>)/,
        (match, pre, _old, post) => pre + updates.phone + post
      );
    }
    if (updates.email !== undefined) {
      html = html.replace(
        /(<div\s+class="ct-text">\s*<h5>Email<\/h5>\s*<p>)([\s\S]*?)(<\/p>)/,
        (match, pre, _old, post) => pre + updates.email + post
      );
    }
  }

  await updateFile(
    octokit,
    owner,
    repo,
    filename,
    html,
    `Update ${page} content via admin panel`,
    sha
  );

  return response(200, { success: true });
}

// 7. cloudinary-config ------------------------------------------------------
async function handleCloudinaryConfig() {
  const { cloudName, uploadPreset } = getCloudinaryConfig();
  if (!cloudName || !uploadPreset) {
    return response(500, { error: "Cloudinary not configured. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET environment variables." });
  }
  return response(200, { cloudName, uploadPreset });
}

// 8. list-cloud-images ------------------------------------------------------
async function handleListCloudImages(queryParams) {
  const category = queryParams.category;
  if (!category) {
    return response(400, { error: "Missing required query parameter: category" });
  }

  const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
  if (!cloudName || !apiKey || !apiSecret) {
    return response(200, []); // Return empty if Cloudinary not configured
  }

  const catDir = categoryToDir(category);
  const folder = `max-digital-studio/${catDir}`;
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  const url = `https://api.cloudinary.com/v1_1/${cloudName}/resources/image?prefix=${encodeURIComponent(folder)}/&type=upload&max_results=500`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error("Cloudinary API error:", errBody);
    return response(200, []); // Graceful fallback
  }

  const data = await res.json();

  const images = (data.resources || []).map((r) => {
    const name = r.public_id.split("/").pop();
    return {
      name,
      publicId: r.public_id,
      thumbUrl: `https://res.cloudinary.com/${cloudName}/image/upload/w_600,q_65,f_webp/${r.public_id}`,
      fullUrl: `https://res.cloudinary.com/${cloudName}/image/upload/f_auto,q_auto/${r.public_id}`,
      source: "cloudinary",
    };
  });

  return response(200, images);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: "",
    };
  }

  // Auth check: require Netlify Identity user
  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return response(401, { error: "Unauthorized: authentication required" });
  }

  try {
    if (event.httpMethod === "GET") {
      const params = event.queryStringParameters || {};
      const action = params.action;

      switch (action) {
        case "list-images":
          return await handleListImages(params);
        case "get-gallery":
          return await handleGetGallery();
        case "get-content":
          return await handleGetContent(params);
        case "cloudinary-config":
          return await handleCloudinaryConfig();
        case "list-cloud-images":
          return await handleListCloudImages(params);
        default:
          return response(400, { error: `Unknown GET action: ${action}` });
      }
    }

    if (event.httpMethod === "POST") {
      let body;
      try {
        body = JSON.parse(event.body);
      } catch (err) {
        return response(400, { error: "Invalid JSON in request body" });
      }

      const action = body.action;

      switch (action) {
        case "rotate-image":
          return await handleRotateImage(body);
        case "update-gallery":
          return await handleUpdateGallery(body);
        case "update-content":
          return await handleUpdateContent(body);
        default:
          return response(400, { error: `Unknown POST action: ${action}` });
      }
    }

    return response(405, { error: `Method not allowed: ${event.httpMethod}` });
  } catch (err) {
    console.error("API error:", err);
    return response(500, {
      error: err.message || "Internal server error",
    });
  }
};
