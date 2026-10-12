import https from 'https';

// GitHub API helper function
function makeGitHubRequest(path, method, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: path,
      method: method,
      headers: {
        'User-Agent': 'Netlify-Function',
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const jsonBody = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(jsonBody);
          } else {
            reject(new Error(`GitHub API error: ${res.statusCode} - ${JSON.stringify(jsonBody)}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}


const entryTitle = (line) => {
  const match = line.match(/^- \[(.+?)\]/);
  return match ? match[1].trim() : null;
};

/**
 * Insert an entry in alphabetical position inside its section, using the same
 * comparator as scripts/parse-readme.js. Appending to the end of the section
 * instead leaves README.md unsorted, which CONTRIBUTING.md requires, and a
 * maintainer then has to move the line by hand after every submission.
 * Exported so the placement can be tested without calling the GitHub API.
 */
export function insertResourceLine(content, categoryHeader, resourceLine) {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === categoryHeader);
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }

  const newTitle = entryTitle(resourceLine);
  let insertAt = -1;
  let lastEntry = -1;

  for (let i = start + 1; i < end; i++) {
    const title = entryTitle(lines[i]);
    if (title === null) continue;
    lastEntry = i;
    if (insertAt === -1 && newTitle !== null &&
        newTitle.localeCompare(title, 'en', { sensitivity: 'base' }) < 0) {
      insertAt = i;
    }
  }

  if (insertAt === -1) {
    // Sorts last, or the section has no entries yet: go after the final entry,
    // or after the section's prose while keeping the blank line before the next
    // heading intact.
    insertAt = lastEntry !== -1 ? lastEntry + 1 : end;
    while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  }

  const updated = [...lines];
  updated.splice(insertAt, 0, resourceLine);
  return updated.join('\n');
}

export const handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body);

    // Collapse newlines and repeated whitespace. The README entry must stay on a
    // single line - a line break inside the description turns the rest of it into
    // a loose paragraph that the README parser silently drops.
    const singleLine = (value) => (value == null ? value : String(value).replace(/\s+/g, ' ').trim());

    const category = body.category;
    const resourceName = singleLine(body.resourceName);
    const resourceUrl = singleLine(body.resourceUrl);
    const description = singleLine(body.description);
    const {
      submitterName,
      submitterGithub
    } = body;

    // Validate required fields
    if (!category || !resourceName || !resourceUrl || !description) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    const REPO_OWNER = 'selfishprimate';
    const REPO_NAME = 'mossaique';
    const BASE_BRANCH = 'main';

    // 1. Get the base branch reference
    const baseBranchRef = await makeGitHubRequest(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${BASE_BRANCH}`,
      'GET'
    );
    const baseSha = baseBranchRef.object.sha;

    // 2. Create a new branch
    const branchName = `add-resource-${Date.now()}`;
    await makeGitHubRequest(
      `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`,
      'POST',
      {
        ref: `refs/heads/${branchName}`,
        sha: baseSha
      }
    );

    // 3. Get current README.md content
    const readmeFile = await makeGitHubRequest(
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/README.md?ref=${branchName}`,
      'GET'
    );
    const currentContent = Buffer.from(readmeFile.content, 'base64').toString('utf-8');

    // 4. Find the category section and add the new resource
    const categoryHeaders = {
      'accessibility': '## Accessibility',
      'ai': '## AI',
      'articles': '## Articles',
      'blogs': '## Blogs',
      'books': '## Books',
      'color': '## Color',
      'design-news': '## Design News',
      'design-systems': '## Design Systems',
      'figma-plugins': '## Figma Plugins',
      'frontend-design': '## Frontend Design',
      'graphic-design': '## Graphic Design',
      'icons': '## Icons',
      'inspiration': '## Inspiration',
      'mockup': '## Mockup',
      'productivity': '## Productivity',
      'prototyping': '## Prototyping',
      'stock-photos': '## Stock Photos',
      'stock-videos': '## Stock Videos',
      'tutorials': '## Tutorials',
      'typography': '## Typography',
      'ui-animation': '## UI Animation',
      'ui-design': '## UI Design',
      'ux-design': '## UX Design',
      'wireframing': '## Wireframing',
      'others': '## Others'
    };

    const categoryHeader = categoryHeaders[category];
    if (!categoryHeader) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid category' })
      };
    }

    // Find the category section
    const categoryIndex = currentContent.indexOf(categoryHeader);
    if (categoryIndex === -1) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Category section not found in README' })
      };
    }

    // Create the new resource line
    // Must match the documented "[Title](URL): Description" format. With " - " the parser
    // leaves the dash attached to the description, and the site renders it.
    const newResourceLine = `- [${resourceName}](${resourceUrl}): ${description}`;

    const newContent = insertResourceLine(currentContent, categoryHeader, newResourceLine);
    if (newContent === null) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Category section not found in README' })
      };
    }

    // 5. Update the README.md file
    await makeGitHubRequest(
      `/repos/${REPO_OWNER}/${REPO_NAME}/contents/README.md`,
      'PUT',
      {
        message: `Add ${resourceName} to ${categoryHeader.replace('## ', '')}${submitterName ? ` (submitted by ${submitterName})` : ''}`,
        content: Buffer.from(newContent).toString('base64'),
        branch: branchName,
        sha: readmeFile.sha
      }
    );

    // 6. Create a pull request
    // Credit uses public identifiers only. PR bodies are public on this repo, so
    // the form deliberately does not collect or publish submitters' email addresses.
    const submitterInfo = [];
    if (submitterName) submitterInfo.push(`**Name:** ${submitterName}`);
    if (submitterGithub) submitterInfo.push(`**GitHub:** @${submitterGithub}`);

    const prBody = `## New Resource Submission

**Resource:** ${resourceName}
**Category:** ${categoryHeader.replace('## ', '')}
**URL:** ${resourceUrl}
**Description:** ${description}

${submitterInfo.length > 0 ? '## Submitted by\n\n' + submitterInfo.join('\n') : ''}

---
*This PR was automatically created via the website submission form.*`;

    const pr = await makeGitHubRequest(
      `/repos/${REPO_OWNER}/${REPO_NAME}/pulls`,
      'POST',
      {
        title: `Add ${resourceName}`,
        head: branchName,
        base: BASE_BRANCH,
        body: prBody
      }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        prNumber: pr.number,
        prUrl: pr.html_url
      })
    };

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to create pull request',
        message: error.message
      })
    };
  }
};
