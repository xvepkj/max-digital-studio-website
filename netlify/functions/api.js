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

  // Build new gallery items HTML
  const itemsHtml = items
    .map((item) => {
      const catDir = categoryToDir(item.category);
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

  const pageFileMap = {
    home: "index.html",
    about: "about.html",
    services: "services.html",
    contact: "contact.html",
    events: "events.html",
    gallery: "gallery.html",
  };

  const filename = pageFileMap[page] || `${page}.html`;
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
    // Parse hero slides
    const heroSlides = [];
    const slideRegex =
      /<div\s+class="hs-item\s+set-bg"[^>]*>[\s\S]*?<h2>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g;
    let slideMatch;
    while ((slideMatch = slideRegex.exec(htmlContent)) !== null) {
      heroSlides.push({
        title: slideMatch[1].trim(),
        description: slideMatch[2].trim(),
      });
    }
    parsed.hero = heroSlides;

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

    // Parse portfolio items
    const portfolioItems = [];
    const pfRegex =
      /<div\s+class="pf-item[^"]*"\s+data-setbg="([^"]+)">\s*<a\s+href="([^"]+)"/g;
    let pfMatch;
    while ((pfMatch = pfRegex.exec(htmlContent)) !== null) {
      const thumb = pfMatch[1];
      const full = pfMatch[2];
      const pathParts = thumb.split("/");
      const fname = pathParts[pathParts.length - 1];
      const catDirName = pathParts.length >= 3 ? pathParts[2] : "";
      portfolioItems.push({
        thumbPath: thumb,
        fullPath: full,
        filename: fname,
        category: dirToCategory(catDirName),
      });
    }
    parsed.portfolio = portfolioItems;
  } else if (page === "about") {
    // Parse section title and description
    const titleMatch = htmlContent.match(
      /<div\s+class="section-title">\s*<h2>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>/
    );
    if (titleMatch) {
      parsed.title = titleMatch[1].trim();
      parsed.description = titleMatch[2].trim();
    }

    // Parse list items
    const listItems = [];
    const liRegex =
      /<div\s+class="al-text">\s*<h5>([\s\S]*?)<\/h5>\s*<p>([\s\S]*?)<\/p>/g;
    let liMatch;
    while ((liMatch = liRegex.exec(htmlContent)) !== null) {
      listItems.push({
        title: liMatch[1].trim(),
        description: liMatch[2].trim(),
      });
    }
    parsed.listItems = listItems;
  }

  return response(200, parsed);
}

// 6. update-content --------------------------------------------------------
async function handleUpdateContent(body) {
  const { page, content: updates } = body;

  if (!page || !updates) {
    return response(400, { error: "Missing required fields: page, content" });
  }

  const pageFileMap = {
    home: "index.html",
    about: "about.html",
    services: "services.html",
    contact: "contact.html",
    events: "events.html",
    gallery: "gallery.html",
  };

  const filename = pageFileMap[page] || `${page}.html`;
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
    // Update hero slides
    if (updates.hero && Array.isArray(updates.hero)) {
      let slideIndex = 0;
      html = html.replace(
        /(<div\s+class="hs-text">\s*<h2>)([\s\S]*?)(<\/h2>\s*<p>)([\s\S]*?)(<\/p>)/g,
        (match, before_h2, _oldTitle, between, _oldDesc, after_p) => {
          if (slideIndex < updates.hero.length) {
            const slide = updates.hero[slideIndex];
            slideIndex++;
            return (
              before_h2 +
              (slide.title || _oldTitle) +
              between +
              (slide.description || _oldDesc) +
              after_p
            );
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

    // Update list items
    if (updates.listItems && Array.isArray(updates.listItems)) {
      let liIndex = 0;
      html = html.replace(
        /(<div\s+class="al-text">\s*<h5>)([\s\S]*?)(<\/h5>\s*<p>)([\s\S]*?)(<\/p>)/g,
        (match, pre_h5, oldTitle, between, oldDesc, after) => {
          if (liIndex < updates.listItems.length) {
            const item = updates.listItems[liIndex];
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
