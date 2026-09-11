// An Antora extension to check for Prime and Community context appropriate 
// URL usage. The extension parses an input file containing a list of
// Product-only URLs and a list of Community-only URLs to determine what
// context a given URL should be used in.
//
// When a build is defined (using the build-type attribute) to be for the
// Product context, any Community-only URL found in a page is considered a
// violation.
//
// Conversely, when a build is defined to be for the Community context, any
// Product-only URL found in a page is considered a violation. 
//
// If a page is only included in the nav.adoc file for a given context and
// contains URLs that are not appropriate for the given build type, it is not
// flagged as a violation. 
//
// Playbook configuration
//
// antora:
//   extensions:
//   - require: ./product-docs-common/extensions/prime-community-urls/prime-community-urls.js
//     input: ./product-docs-common/data/prod_comm_url_types.json

'use strict'

const fs = require('fs')
const path = require('path')

// Helper function to strip http(s):// protocol and trailing slashes
function normalizeUrl (url) {
  return url
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
}

// Pre-compile regular expressions targeting HTML link/source attributes
function createMatchers (urls) {
  return urls
    .map((url) => {
      const normalized = normalizeUrl(url)
      if (!normalized) return null
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return {
        original: url,
        regex: new RegExp(`(?:href|src)=["'](?:https?:)?\\/\\/(?:[^"']*\\b)?${escaped}(?:[\\/\\?#"'\\s]|$)`, 'i'),
      }
    })
    .filter(Boolean)
}

// Recursive helper to extract internal page URLs from the evaluated navigation tree
function collectNavUrls (items = [], set = new Set()) {
  items.forEach((item) => {
    if (item.urlType === 'internal' && item.url) {
      set.add(item.url.split('#')[0])
    }
    if (item.items && item.items.length) {
      collectNavUrls(item.items, set)
    }
  })
  return set
}

module.exports.register = function ({ config }) {
  const logger = this.getLogger('url-checker-extension')
  const inputFilePath = config.input || path.resolve(process.cwd(), 'input.json')

  let productOnlyMatchers = []
  let communityOnlyMatchers = []

  try {
    const fileContents = fs.readFileSync(inputFilePath, 'utf8')
    const urlData = JSON.parse(fileContents)
    productOnlyMatchers = createMatchers(urlData['product-only'] || [])
    communityOnlyMatchers = createMatchers(urlData['community-only'] || [])
  } catch (err) {
    logger.error(`Failed to read or parse ${inputFilePath}: ${err.message}`)
    return
  }

  // Hook into 'navigationBuilt' so nav.adoc conditionals are fully evaluated
  this.on('navigationBuilt', ({ contentCatalog }) => {
    const navUrlsByComponentVersion = new Map()
    const pages = contentCatalog.getPages((page) => page.out)

    pages.forEach((page) => {
      const componentVersion = contentCatalog.getComponentVersion(
        page.src.component,
        page.src.version
      )

      const attributes = componentVersion?.asciidoc?.attributes
      const buildType = attributes?.['build-type'] || 'product'

      // Verify whether the page is included in the evaluated navigation tree
      if (componentVersion.navigation && componentVersion.navigation.length) {
        let navUrls = navUrlsByComponentVersion.get(componentVersion)
        if (!navUrls) {
          navUrls = collectNavUrls(componentVersion.navigation)
          navUrlsByComponentVersion.set(componentVersion, navUrls)
        }

        // Skip pages that were conditionalized out of nav.adoc
        if (page.pub?.url && !navUrls.has(page.pub.url)) {
          return
        }
      }

      const forbiddenMatchers = buildType === 'community' ? productOnlyMatchers : communityOnlyMatchers
      if (forbiddenMatchers.length === 0) return

      const contentStr = page.contents.toString()

      const foundUrls = forbiddenMatchers
        .filter(({ regex }) => regex.test(contentStr))
        .map(({ original }) => original)

      if (foundUrls.length > 0) {
        logger.info(
          { file: page.src, source: page.src.origin },
          `Build-type '${buildType}' restriction triggered: forbidden URL(s) found [${foundUrls.join(', ')}]`
        )
      }
    })
  })
}