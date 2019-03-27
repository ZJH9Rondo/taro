import * as fs from 'fs-extra'
import * as path from 'path'

import * as autoprefixer from 'autoprefixer'
import * as postcss from 'postcss'
import * as pxtransform from 'postcss-pxtransform'
import * as cssUrlParse from 'postcss-url'
import * as Scope from 'postcss-modules-scope'
import * as Values from 'postcss-modules-values'
import * as LocalByDefault from 'postcss-modules-local-by-default'
import * as ExtractImports from 'postcss-modules-extract-imports'
import * as ResolveImports from 'postcss-modules-resolve-imports'

import browserList from '../config/browser_list'
import {
  resolveNpmPkgMainPath,
  resolveNpmFilesPath
} from '../util/resolve_npm_files'
import {
  callPlugin, callPluginSync
} from '../util/npm'
import {
  isNpmPkg,
  processStyleImports,
  promoteRelativePath
} from '../util'
import { CSS_EXT, FILE_PROCESSOR_MAP, DEVICE_RATIO_NAME, BUILD_TYPES } from '../util/constants'
import { IMiniAppConfig } from '../util/types'

import {
  getBuildData
} from './helper'

const genericNames = require('generic-names')

interface IStyleObj {
  css: string,
  filePath: string
}

const appPath = process.cwd()
const isBuildingStyles: Map<string, boolean> = new Map<string, boolean>()

export function initCompileStyles () {
  isBuildingStyles.clear()
}

/**
 * css module processor
 * @param styleObj { css: string, filePath: '' }
 * @returns postcss.process()
 */
export function processStyleUseCssModule (styleObj: IStyleObj): any {
  const { projectConfig } = getBuildData()
  const weappConf = Object.assign({}, projectConfig.weapp)
  const useModuleConf = weappConf.module || {}
  const customPostcssConf = useModuleConf.postcss || {}
  const customCssModulesConf = Object.assign({
    enable: false,
    config: {
      generateScopedName: '[name]__[local]___[hash:base64:5]',
      namingPattern: 'global'
    }
  }, customPostcssConf.cssModules || {})
  if (!customCssModulesConf.enable) {
    return styleObj
  }
  const namingPattern = customCssModulesConf.config.namingPattern
  if (namingPattern === 'module') {
    // 只对 xxx.module.[css|scss|less|styl] 等样式文件做处理
    const DO_USE_CSS_MODULE_REGEX = /^(.*\.module).*\.(css|scss|less|styl)$/
    if (!DO_USE_CSS_MODULE_REGEX.test(styleObj.filePath)) return styleObj
  } else {
    // 对 xxx.global.[css|scss|less|styl] 等样式文件不做处理
    const DO_NOT_USE_CSS_MODULE_REGEX = /^(.*\.global).*\.(css|scss|less|styl)$/
    if (DO_NOT_USE_CSS_MODULE_REGEX.test(styleObj.filePath)) return styleObj
  }
  const generateScopedName = customCssModulesConf.config.generateScopedName
  const context = process.cwd()
  let scopedName
  if (generateScopedName) {
    scopedName = genericNames(generateScopedName, { context })
  } else {
    scopedName = (local, filename) => Scope.generateScopedName(local, path.relative(context, filename))
  }
  const postcssPlugins = [
    Values,
    LocalByDefault,
    ExtractImports,
    new Scope({ generateScopedName: scopedName }),
    new ResolveImports({ resolve: Object.assign({}, { extensions: CSS_EXT }) })
  ]
  const runner = postcss(postcssPlugins)
  const result = runner.process(styleObj.css, Object.assign({}, { from: styleObj.filePath }))
  return result
}

async function processStyleWithPostCSS (styleObj: IStyleObj): Promise<string> {
  const { projectConfig, npmConfig, isProduction, buildAdapter } = getBuildData()
  const weappConf = Object.assign({}, projectConfig.weapp)
  const useModuleConf = weappConf.module || {}
  const customPostcssConf = useModuleConf.postcss || {}
  const customCssModulesConf = Object.assign({
    enable: false,
    config: {
      generateScopedName: '[name]__[local]___[hash:base64:5]'
    }
  }, customPostcssConf.cssModules || {})
  const customPxtransformConf = Object.assign({
    enable: true,
    config: {}
  }, customPostcssConf.pxtransform || {})
  const customUrlConf = Object.assign({
    enable: true,
    config: {
      limit: 10240
    }
  }, customPostcssConf.url || {})
  const customAutoprefixerConf = Object.assign({
    enable: true,
    config: {
      browsers: browserList
    }
  }, customPostcssConf.autoprefixer || {})
  const postcssPxtransformOption = {
    designWidth: projectConfig.designWidth || 750,
    platform: 'weapp'
  }

  if (projectConfig.hasOwnProperty(DEVICE_RATIO_NAME)) {
    postcssPxtransformOption[DEVICE_RATIO_NAME] = projectConfig.deviceRatio
  }
  const cssUrlConf = Object.assign({ limit: 10240 }, customUrlConf)
  const maxSize = Math.round((customUrlConf.config.limit || cssUrlConf.limit) / 1024)
  const postcssPxtransformConf = Object.assign({}, postcssPxtransformOption, customPxtransformConf, customPxtransformConf.config)
  const processors: any[] = []
  if (customAutoprefixerConf.enable) {
    processors.push(autoprefixer(customAutoprefixerConf.config))
  }
  if (customPxtransformConf.enable && buildAdapter !== BUILD_TYPES.QUICKAPP) {
    processors.push(pxtransform(postcssPxtransformConf))
  }
  if (cssUrlConf.enable) {
    processors.push(cssUrlParse({
      url: 'inline',
      maxSize,
      encodeType: 'base64'
    }))
  }

  const defaultPostCSSPluginNames = ['autoprefixer', 'pxtransform', 'url', 'cssModules']
  Object.keys(customPostcssConf).forEach(pluginName => {
    if (defaultPostCSSPluginNames.indexOf(pluginName) < 0) {
      const pluginConf = customPostcssConf[pluginName]
      if (pluginConf && pluginConf.enable) {
        if (!isNpmPkg(pluginName)) { // local plugin
          pluginName = path.join(appPath, pluginName)
        }
        processors.push(require(resolveNpmPkgMainPath(pluginName, isProduction, npmConfig, buildAdapter))(pluginConf.config || {}))
      }
    }
  })
  let css = styleObj.css
  if (customCssModulesConf.enable) {
    css = processStyleUseCssModule(styleObj).css
  }
  const postcssResult = await postcss(processors).process(css, {
    from: styleObj.filePath
  })
  return postcssResult.css
}

function compileImportStyles (filePath: string, importStyles: string[]) {
  const { sourceDir, outputDir } = getBuildData()
  if (importStyles.length) {
    importStyles.forEach(async importItem => {
      const importFilePath = path.resolve(filePath, '..', importItem)
      if (fs.existsSync(importFilePath)) {
        await compileDepStyles(importFilePath.replace(sourceDir, outputDir), [importFilePath])
      }
    })
  }
}

export function compileDepStyles (outputFilePath: string, styleFiles: string[]) {
  if (isBuildingStyles.get(outputFilePath)) {
    return Promise.resolve({})
  }
  const { projectConfig, npmConfig, isProduction, buildAdapter } = getBuildData()
  const pluginsConfig = projectConfig.plugins || {}
  const weappConf = projectConfig.weapp || {} as IMiniAppConfig
  const useCompileConf = Object.assign({}, weappConf.compile)
  const compileInclude = useCompileConf.include || []
  isBuildingStyles.set(outputFilePath, true)
  return Promise.all(styleFiles.map(async p => {
    const filePath = path.join(p)
    const fileExt = path.extname(filePath)
    const pluginName = FILE_PROCESSOR_MAP[fileExt]
    const fileContent = fs.readFileSync(filePath).toString()
    const cssImportsRes = processStyleImports(fileContent, buildAdapter, (str, stylePath) => {
      if (stylePath.indexOf('~') === 0) {
        let newStylePath = stylePath
        newStylePath = stylePath.replace('~', '')
        const npmInfo = resolveNpmFilesPath(newStylePath, isProduction, npmConfig, buildAdapter, appPath, compileInclude)
        const importRelativePath = promoteRelativePath(path.relative(filePath, npmInfo.main))
        return str.replace(stylePath, importRelativePath)
      }
      return str
    })
    compileImportStyles(filePath, cssImportsRes.imports)
    if (pluginName) {
      return callPlugin(pluginName, cssImportsRes.content, filePath, pluginsConfig[pluginName] || {})
        .then(res => ({
          css: cssImportsRes.style.join('\n') + '\n' + res.css,
          filePath
        }))
    }
    return new Promise(resolve => {
      resolve({
        css: cssImportsRes.style.join('\n') + '\n' + cssImportsRes.content,
        filePath
      })
    })
  })).then(async resList => {
    Promise.all(resList.map(res => processStyleWithPostCSS(res)))
      .then(cssList => {
        let resContent = cssList.map(res => res).join('\n')
        if (isProduction) {
          const cssoPuginConfig = pluginsConfig.csso || { enable: true }
          if (cssoPuginConfig.enable) {
            const cssoConfig = cssoPuginConfig.config || {}
            const cssoResult = callPluginSync('csso', resContent, outputFilePath, cssoConfig)
            resContent = cssoResult.css
          }
        }
        fs.ensureDirSync(path.dirname(outputFilePath))
        fs.writeFileSync(outputFilePath, resContent)
      })
  })
}
