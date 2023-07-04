#!/usr/bin/env node

import { program } from 'commander'
import fg from 'fast-glob'
import { type BuildOptions, context, Metafile, build } from 'esbuild'
import log, { chalk } from '@techor/log'
import path from 'upath'
import line, { l } from '@techor/one-liner'
import type { PackageJson } from 'pkg-types'
import prettyBytes from 'pretty-bytes'
import normalizePath from 'normalize-path'
import fs from 'fs'
import isEqual from 'lodash.isequal'
import { esbuildOptionNames } from '../utils/esbuild-option-names'
import { createFillModuleExtPlugin } from '../plugins/esbuild-plugin-fill-module-ext'
import { removeImportSvelteModuleExtensionPlugin } from '../plugins/esbuild-remove-import-svelte-module-extension'
import extend from '@techor/extend'
import { readFileAsJSON } from '@techor/fs'
import exploreConfig from 'explore-config'
import { execaCommand } from 'execa'

const ext2format = {
    'js': 'cjs',
    'cjs': 'cjs',
    'mjs': 'esm',
    'css': 'css'
}

declare type BuildTask = { options?: BuildOptions, metafile?: Metafile, run: () => Promise<any> }
const pkg: PackageJson = readFileAsJSON('./package.json')
const { dependencies, peerDependencies } = pkg
/** Extract external dependencies to prevent bundling */
const externalDependencies = []
dependencies && externalDependencies.push(...Object.keys(dependencies))
peerDependencies && externalDependencies.push(...Object.keys(peerDependencies))

program.command('pack [entryPaths...]', { isDefault: true })
    .option('-f, --format [formats...]', 'The output format for the generated JavaScript files `iife`, `cjs`, `esm`', ['cjs', 'esm'])
    .option('-t, --shakable-format [formats...]', 'Tree-shakable module\'s formats', ['cjs', 'esm'])
    .option('--shakable', 'Enable outputting tree-shakable modules', false)
    .option('-w, --watch', 'Rebuild whenever a file changes', false)
    .option('-s, --sourcemap', 'Emit a source map', process.env.NODE_ENV === 'production')
    .option('-p, --platform <node,browser,neutral>', 'Platform target', 'browser')
    .option('-o, --outdir <dir>', 'The output directory for the build operation', 'dist')
    .option('--serve', 'Serve mode starts a web server that serves your code to your browser on your device', false)
    .option('--bundle', 'Inline any imported dependencies into the file itself', false)
    .option('-e, --external <packages...>', 'External packages to exclude from the build', externalDependencies)
    .option('-ee, --extra-external <packages...>', 'Extra external packages to exclude from the build', [])
    .option('-re, --resolve-extensions [extensions...]', 'The resolution algorithm used by node supports implicit file extensions', ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'])
    .option('-kn, --keep-names', 'Keep JavaScript function/class names', false)
    .option('--cjs-ext <ext>', 'Specify CommonJS default file extension', '.js')
    .option('--iife-ext <ext>', 'Specify CommonJS default file extension', '.js')
    .option('--esm-ext <ext>', 'Specify CommonJS default file extension', '.mjs')
    .option('--framework <name>', 'Specify a framework like `svelte` to resolve related issues automatically')
    .option('--srcdir <dir>', 'The source directory', 'src')
    .option('--target [targets...]', 'This sets the target environment for the generated JavaScript and/or CSS code.')
    .option('--mangle-props', 'Pass a regular expression to esbuild to tell esbuild to automatically rename all properties that match this regular expression', '^_')
    .option('--no-declare', 'OFF: Emit typescript declarations', !!pkg.types)
    .option('--no-minify', 'OFF: Minify the generated code')
    .option('--no-clean', 'OFF: Clean up the previous output directory before the build starts')
    .action(async function (entries: string[], options, args) {
        if (options.clean && fs.existsSync(options.outdir)) {
            fs.rmSync(options.outdir, { force: true, recursive: true })
            console.log('')
            log.d`Cleaned up the **${options.outdir}** output directory`
        }
        const useConfig = exploreConfig('techor.*')
        const buildTasks: BuildTask[] = []
        const resolvePackageEntry = (filePath: string, targetExt: string) => {
            const subFilePath /* components/a.ts */ = path.relative(options.outdir, filePath.replace('.bundle', ''))
            const srcFilePath /* src/components/a.ts */ = path.join(options.srcdir, subFilePath)
            return path.changeExt(srcFilePath, targetExt)
        }
        const addBuildTask = async (eachEntries: string[], eachOptions: { format: string, bundle?: boolean, softBundle?: boolean, ext?: string, platform?: string, outdir?: string, outFile?: string }) => {
            const isCSSTask = eachOptions.format === 'css'
            let eachOutExt = eachOptions.ext || eachOptions.outFile && path.extname(eachOptions.outFile) || undefined
            if (!eachOutExt) {
                eachOutExt = { cjs: options.cjsExt, esm: options.esmExt, iife: options.iifeExt }[eachOptions.format]
            }
            if (eachOptions.bundle === undefined) {
                eachOptions.bundle = options.bundle
            }
            const external = [
                ...options.external,
                ...options.extraExternal
            ]
            const eachOutdir = eachOptions.outdir || options.outdir
            if (eachOptions.bundle && eachOptions.softBundle) {
                external.push('.*')
            }
            console.log(eachOptions.outFile)
            const buildOptions: BuildOptions = extend(options, {
                outExtension: isCSSTask
                    ? { '.css': '.css' }
                    : { '.js': eachOutExt },
                logLevel: 'info',
                outdir: eachOptions.outFile ? undefined : eachOutdir,
                bundle: eachOptions.bundle,
                outfile: eachOptions.outFile,
                outbase: options.srcdir,
                platform: eachOptions.platform || options.platform,
                metafile: true,
                format: isCSSTask ? undefined : eachOptions.format,
                keepNames: options.keepNames,
                resolveExtensions: options.resolveExtensions,
                mangleProps: options.mangleProps ? new RegExp(options.mangleProps) : undefined,
                target: options.target,
                sourcemap: options.sourcemap,
                external,
                plugins: [],
            } as BuildOptions, useConfig?.pack)

            if (!buildOptions.target) {
                delete buildOptions.target
            }

            if (!eachOptions.bundle) {
                delete buildOptions.external
            }

            switch (options.framework) {
                case 'svelte':
                    buildOptions.plugins.push(removeImportSvelteModuleExtensionPlugin)
                    break
            }

            if (eachOptions.softBundle && eachOptions.format === 'esm') {
                buildOptions.plugins.push(createFillModuleExtPlugin(options.esmExt))
            }

            // Fix ERROR: Invalid option in build() call
            delete buildOptions['watch']
            delete buildOptions['serve']
            delete buildOptions['framework']

            // 安全地同步選項給 esbuild
            for (const eachBuildOptionName in buildOptions) {
                if (!esbuildOptionNames.includes(eachBuildOptionName)) {
                    delete buildOptions[eachBuildOptionName]
                }
            }

            buildOptions.entryPoints =
                fg.sync(
                    [...new Set(eachEntries)].map((eachEntry) => normalizePath(eachEntry))
                )
                    .filter((eachEntry: never) =>
                        !buildTasks.find((eachBuildTask) =>
                            (eachBuildTask.options.entryPoints as []).includes(eachEntry)
                            && eachBuildTask.options.format === buildOptions.format
                            && isEqual(eachBuildTask.options.outExtension, buildOptions.outExtension)
                            && eachBuildTask.options.outdir === buildOptions.outdir
                            && eachBuildTask.options.outfile === buildOptions.outfile
                        )
                    )
            if (!buildOptions.entryPoints.length) {
                return
            }

            const eachBuildTask: BuildTask = {
                options: buildOptions,
                run: async () => {
                    const ctx = await context(buildOptions)
                    const { metafile } = await ctx.rebuild()
                    if (metafile) {
                        eachBuildTask.metafile = metafile
                        for (const outputFilePath in metafile.outputs) {
                            const eachOutput = metafile.outputs[outputFilePath]
                            const outputSize = prettyBytes(eachOutput.bytes).replace(/ /g, '')
                            eachOutput['format'] = buildOptions.format
                            log``
                            log.i`**${outputFilePath}** ${outputSize} (${Object.keys(eachOutput.inputs).length} inputs)`
                        }
                        log.tree({
                            entries: buildOptions.entryPoints,
                            external: buildOptions.external,
                            outdir: buildOptions.outdir,
                            format: buildOptions.format,
                            platform: buildOptions.platform,
                            target: buildOptions.target,
                            [
                                Object.keys(buildOptions)
                                    .filter((x) => buildOptions[x] === true)
                                    .map((x) => chalk.green('✓ ') + x)
                                    .join(', ')
                            ]: null
                        })
                    }
                    if (options.watch) {
                        await ctx.watch()
                    } else {
                        await ctx.dispose()
                    }
                    if (options.serve) {
                        await ctx.serve()
                    }
                }
            }

            buildTasks.push(eachBuildTask)
        }

        if (options.shakable && options.shakableFormat.length) {
            options.shakableFormat.forEach((eachFormat: string) =>
                addBuildTask(
                    [path.join(options.srcdir, '**/*.{js,ts,jsx,tsx,mjs,mts}')],
                    { format: eachFormat, platform: 'node', outdir: path.join(options.outdir), softBundle: true }
                ))
        }

        if (entries.length) {
            const cssEntries = entries.filter((eachEntry) => eachEntry.includes('.css'))
            const jsEntries = entries.filter((eachEntry) => !eachEntry.includes('.css'))
            if (cssEntries.length) {
                addBuildTask(cssEntries, { format: 'css' })
            }
            if (jsEntries.length) {
                options.format.forEach((eachFormat: string) => addBuildTask(jsEntries, { format: eachFormat }))
            }
        } else {
            if (pkg.exports) {
                (function handleExports(eachExports: any, eachParentKey: string, eachOptions?: { format?: string, outFile?: string, platform?: string }) {
                    if (typeof eachExports === 'string') {
                        const exportsExt = path.extname(eachExports).slice(1)
                        addBuildTask([resolvePackageEntry(eachExports, '.{js,ts,jsx,tsx,mjs,mts}')], {
                            format: ext2format[exportsExt],
                            outFile: options.outFile || eachExports,
                            platform: options.platform,
                            bundle: eachExports.includes('.bundle')
                        })
                    } else {
                        for (const eachExportKey in eachExports) {
                            const eachUnknowExports = eachExports[eachExportKey]
                            let eachFormat: string
                            let eachPlatform: string
                            switch (eachParentKey) {
                                case 'node':
                                    eachPlatform = 'node'
                                    break
                                case 'browser':
                                    eachPlatform = 'browser'
                                    break
                                case 'require':
                                    eachFormat = 'cjs'
                                    break
                                case 'import':
                                    eachFormat = 'esm'
                                    break
                            }
                            if (eachExportKey.startsWith('.')) {
                                handleExports(eachUnknowExports, eachExportKey)
                            } else {
                                switch (eachExportKey) {
                                    case 'node':
                                        handleExports(eachUnknowExports, eachExportKey, { platform: 'node', format: eachFormat })
                                        break
                                    case 'browser':
                                        handleExports(eachUnknowExports, eachExportKey, { platform: 'browser', format: eachFormat })
                                        break
                                    case 'default':
                                        handleExports(eachUnknowExports, eachExportKey, { platform: eachPlatform, format: eachFormat })
                                        break
                                    case 'require':
                                        handleExports(eachUnknowExports, eachExportKey, { platform: eachPlatform, format: 'cjs' })
                                        break
                                    case 'import':
                                        handleExports(eachUnknowExports, eachExportKey, { platform: eachPlatform, format: 'esm' })
                                        break
                                }
                            }
                        }
                    }
                })(pkg.exports, '')
            }
            if (pkg.style) {
                addBuildTask([resolvePackageEntry(pkg.style, '.css')], { format: 'css', outFile: pkg.style, bundle: pkg.main.includes('.bundle') })
            }
            if (pkg.main && !pkg.main.endsWith('.css')) {
                addBuildTask([resolvePackageEntry(pkg.main, '.{js,ts,jsx,tsx,mjs,mts}')], { format: 'cjs', outFile: pkg.main, bundle: pkg.main.includes('.bundle') })
            }
            if (pkg.module) {
                addBuildTask([resolvePackageEntry(pkg.module, '.{js,ts,jsx,tsx,mjs,mts}')], { format: 'esm', outFile: pkg.module, bundle: pkg.module.includes('.bundle') })
            }
            if (pkg.browser) {
                addBuildTask([resolvePackageEntry(pkg.browser, '.{js,ts,jsx,tsx,mjs,mts}')], { format: 'iife', platform: 'browser', outFile: pkg.browser, bundle: pkg.browser.includes('.bundle') })
            }
            if (pkg.bin) {
                if (typeof pkg.bin === 'string') {
                    addBuildTask([resolvePackageEntry(pkg.bin, '.{js,ts,jsx,tsx,mjs,mts}')], { format: 'cjs', platform: 'node', outFile: pkg.bin, bundle: pkg.bin.includes('.bundle') })
                } else {
                    for (const eachCommandName in pkg.bin) {
                        const eachCommandFile = pkg.bin[eachCommandName]
                        addBuildTask([resolvePackageEntry(eachCommandFile, '.{js,ts,jsx,tsx,mjs,mts}')], { format: 'cjs', platform: 'node', outFile: eachCommandFile, bundle: eachCommandFile.includes('.bundle') })
                    }
                }
            }
        }
        if (!buildTasks.length) {
            options.format.map((eachFormat: string) => addBuildTask([path.join(options.srcdir, 'index.ts')], { format: eachFormat }))
        }

        let typeBuildTask: any
        if (options.declare) {
            typeBuildTask = {
                outFile: 'declarations',
                options: {
                    platform: 'type',
                    format: 'dts'
                },
                run: () => new Promise<void>((resolve) => {
                    const runTsc = () => {
                        execaCommand(line`
                            npx tsc
                            --emitDeclarationOnly
                            --preserveWatchOutput
                            --declaration
                            --outDir ${options.outdir}
                            ${options.watch && '--watch --incremental'}
                        `, {
                            stdio: 'inherit',
                            stripFinalNewline: false,
                            cwd: process.cwd()
                        })
                            .catch((reason) => {
                                process.exit()
                            })
                            .finally(resolve)
                    }
                    if (options.watch) {
                        setTimeout(runTsc, 100)
                    } else {
                        runTsc()
                    }
                })
            } as any
            if (!options.watch) {
                buildTasks.push(typeBuildTask)
            }
        }

        await Promise.all(buildTasks.map(({ run }) => run()))

        console.log('')

        if (options.watch && typeBuildTask) {
            buildTasks.push(typeBuildTask)
        }

        for (const eachBuildTask of buildTasks) {
            if (eachBuildTask.metafile) {
                Object.keys(eachBuildTask.metafile.outputs)
                    .forEach((outputFilePath) => {
                        const eachOutput = eachBuildTask.metafile.outputs[outputFilePath]
                        const outputSize = prettyBytes(eachOutput.bytes).replace(/ /g, '')
                        const eachOutputFormat = eachOutput['format']
                        log.ok(l`[${eachBuildTask.options.platform}] **${outputFilePath}** ${outputSize} (${eachOutputFormat})`)
                    })
            } else {
                log.ok(l`[${eachBuildTask.options.format}] **${eachBuildTask['outFile']}** (${eachBuildTask.options.format})`)
            }
        }
        console.log('')
        if (options.watch) {
            log`Start watching ${buildTasks.length} build tasks $t`
        } else {
            log.success`${buildTasks.length} build tasks $t`
        }
        console.log('')

        if (options.watch && typeBuildTask) {
            await typeBuildTask.run()
        }
    })

program.parse(process.argv)