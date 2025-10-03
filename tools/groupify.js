import axios from 'axios'

function run() {
    const storageKeyBundles = 'groupify.v1.bundles';
    const storageKeyGitHubSecret = 'groupify.v1.githubSecret';
    
    const github_api = {
        get_bundles: "https://api.github.com/repos/sejerpz/mod-lv2-data/git/trees/master?recursive=1", 
        create_issue: "https://api.github.com/repos/sejerpz/mod-lv2-data/issues",
        search_issue: "https://api.github.com/search/issues?q={title}+label:groupify+repo:sejerpz/mod-lv2-data&sort=created&order=asc"
    }
    const { createApp, ref, onMounted, watch, defineModel } = Vue
    const app = createApp({
        setup() {
            let bundles = ref([])
            let ttl_preview = ref('')
            let selected_preview = ref('original')
            let original_ttl = ''
            let patched_ttl = ''
            let err = ref(null)
            let ports = ref([])
            let groups = ref([])
            let send_enabled = ref(false)
            let errorMessage = ref(null)
            let isCustomTtl = ref(false)
            const el = ref<HTMLElement | null>(null)
            const toastService = PrimeVue.useToast()
            const confirmationService = PrimeVue.useConfirm()
            let renameGroupDialog = {
                visible: ref(false),
                group: ref(null),
                label: ref(""),
            }
            let githubSecret = {
                visible: ref(false),
                secret: ref(""),
            }
            let customTtl = {
                visible: ref(false),
                content: ref(""),
            }
            let selected_bundle = ref(null)

            function toast(message, title, timeoutMs) {
                toastService.add({summary: title, detail: message, life: timeoutMs ?? 2000})
            }

            // cache bundles status to local storage
            function cache_bundles_status() {
                localStorage.setItem(storageKeyBundles, JSON.stringify(bundles.value))
            }

            function get_plugin_list() {
                bundles.value = []
                axios.get(github_api.get_bundles)
                .then(res => {
                    for(const item of res.data.tree) {
                        const path = item["path"]

                        if ((path?.startsWith('plugins/') || path?.startsWith('plugins-fixed/'))) {
                            console.log(item)
                            if (path?.endsWith('/manifest.ttl')) {
                                const id = path.replace('/manifest.ttl', '')
                                const parentItem = bundles.value.find(element => element.id == id)
                                parentItem.manifest = item;
                            } else if (item["mode"] == '040000' && path.indexOf('/modgui') == -1 ) { // folder
                                var label = path.replace(/^.*[\\/]/, '').replace('.lv2', '')
                                bundles.value.push({id: path, label: label, data: item, manifest: null, ttl: null, patch_available: false, plugins: []})
                            }
                        }
                    }

                    bundles.value.sort((a,b) => {
                        return a.label.localeCompare(b.label)
                    })

                    cache_bundles_status()

                    bundles.value.splice(0, 0, {id: ':custom:', label: 'Custom file', data: null, manifest: null, ttl: null, patch_available: false, plugins: []})
                })
                .catch(err => {
                    console.error('error getting bundles: ', err)
                });
            }

            async function query_plugin_patched(plugin) {
                const url = github_api.search_issue.replaceAll('{title}', plugin.label)

                const res = await axios.get(url)
                console.log('plugin patched: ', res)

                return (res?.data?.total_count ?? 0) > 0
            }

            async function on_selected_bundle_changed() {
                console.log('bundle selected', selected_bundle.value?.id)
                ttl_preview.value = original_ttl = patched_ttl = ''
                send_enabled.value = false
                if (selected_bundle.value) {
                    if (selected_bundle.value.id == ':custom:') {
                        customTtl.visible.value = true
                    } else {
                        // check if the bundle is already patched
                        if (await query_plugin_patched(selected_bundle.value)) {
                            selected_bundle.value.patch_available = true
                            cache_bundles_status()

                            confirmationService.require({
                                message: 'A patch is already submitted for this plugin',
                                header: selected_bundle.value.label,
                                modal: true,
                                acceptProps: {
                                    label: 'Proceed anyway',
                                    severity: 'danger'
                                },
                                rejectProps: {
                                    label: 'Cancel',
                                    severity: 'secondary',
                                },
                                accept: () => {
                                     download_bundle_info(selected_bundle.value)
                                }
                            });
                        } else {
                            // not patch -> download
                            download_bundle_info(selected_bundle.value)
                        }
                    }
                }
            }

            function parse_ports_ttl (ttl_file) {
                const parser = new N3.Parser()

                // parse the ports
                const quads = parser.parse(ttl_file)
                let subjects = []
                let currentPluginQuad = undefined // the bundles defined in this ttl

                selected_bundle.value.plugins.splice(0) // clear the plugins defined in the bundle
                // plugins defined
                  // distinct subject
                for(let quad of quads) {
                    if (!quad.subject.id.startsWith('_') && quad.object.id.indexOf('#Plugin') >= 0) {
                        const label =  quad.subject.id.split('/').pop() // last element
                        selected_bundle.value.plugins.push({id: quad.subject.id, label: label, quad: quad})
                    }
                }

                // distinct subject
                for(let quad of quads) {
                    if (!subjects.find(s => s.id == quad.subject.id)) {
                        console.log("found subject: ", quad.subject.id, quad)
                        subjects.push({id: quad.subject.id, pluginId: currentPluginQuad?.subject.id ?? undefined})
                        if (!quad.subject.id.startsWith('_')) {
                            currentPluginQuad = quad
                        }
                    }
                }

                // subject that are inputports and control ports
                const getInputPort = function(id, q) {
                    if (q.subject.id == id
                        && q.predicate.id.endsWith('#type')
                        && q.object.id.endsWith('#InputPort'))
                        return q
                    else
                        return null
                } 
                const getControlPort = function(id, q) {
                    if (q._subject.id == id
                        && q.predicate.id.endsWith('#type')
                        && q.object.id.endsWith('#ControlPort'))
                        return q
                    else
                        return null
                } 
                const searchPredicate = function(id, q, predicate) {
                    if (q.subject.id == id
                        && q.predicate.id == predicate)
                        return q
                    else
                        return null
                } 

                let _ports = []
                for(let subject of subjects) {
                    if (quads.find(qd => getControlPort(subject.id, qd)) && quads.find(qd => getInputPort(subject.id, qd))) {
                        const label = quads.find(qd => searchPredicate(subject.id, qd, "http://lv2plug.in/ns/lv2core#name"))
                        const symbol = quads.find(qd => searchPredicate(subject.id, qd, "http://lv2plug.in/ns/lv2core#symbol"))
                        const index =  quads.find(qd => searchPredicate(subject.id, qd, "http://lv2plug.in/ns/lv2core#index"))

                        const port = { id: subject.id,
                                        label: label?.object?.id.replace('"', '').replace('"', ''),
                                        symbol: symbol?.object.id.replace('"', '').replace('"', ''),
                                        index: parseInt(index.object.value) ?? 0,
                                        group: groups.value[0],
                                        selected: false,
                                        pluginId: subject.pluginId
                                    }
                        _ports.push(port)
                        //console.log('added ', port)
                    }
                }

                // sort ports
                _ports.sort((a, b) => {
                    if (a.index == b.index)
                        return 0
                    else if (a.index < b.index)
                        return -1
                    else
                        return 1
                });

                // all done
                ports.value = _ports;
            }

            // returns a list of ports defined in the plugin with the id supplied
            function get_plugin_ports(plugin) {
                const pluginPorts = []

                if (plugin?.id && ports?.value) {
                    for(const port of ports.value) {
                        if (port.pluginId == plugin.id) {
                            pluginPorts.push(port)
                        }
                    }
                }

                return pluginPorts
            }

            function download_bundle_info(bundle) {
                console.log('download bundle info: ', bundle.id)

                toast('Get bundle manifest from github.com', 'Download in progress')
                // download manifest.ttl
                axios.get(bundle.manifest.url)
                .then(res => {
                    //console.log('manifest.ttl downloaded ', res)
                    // parse manifest ttl
                    const manifest = atob(res.data.content)
                    //console.log('manifest ', manifest)
                    const parser = new N3.Parser()
                    const quads = parser.parse(manifest)

                    // search the first quad which is a lv2:bundle and get the subject
                    let subject = null

                    for(const quad of quads) {
                        if (quad._object.id == "http://lv2plug.in/ns/lv2core#Plugin") {
                            subject = quad._subject.id
                            break;
                        }
                    }

                    // search the first quad seeAlso for the subject and get the plugin ttl
                    let bundleTtl = null
                    if (subject) {
                        for(const quad of quads) {
                            if (quad._object.id == "modgui.ttl" || quad._object.id == "modguis.ttl")
                                continue; // skip know ttl

                            if (quad._subject.id == subject && quad._predicate.id.endsWith("#seeAlso")) {
                                bundleTtl = quad._object.id
                                // cleanup

                            }
                        }
                    }
                    // download bundle ttl
                    if (bundleTtl) {
                        console.log('downloading ', bundle, bundleTtl)
                        // get the folder list

                        ttl_preview.value = original_ttl = patched_ttl = ''
                        send_enabled.value = false
                        isCustomTtl.value = false
                        bundle.plugins.splice(0)
                        ports.value = []

                        axios.get(bundle.data.url)
                        .then(res => {
                            if (res?.data?.tree) {
                                for(var item of res.data.tree) {
                                    //console.log(item)
                                    if (item.path == bundleTtl) {
                                        // found the ttl
                                        axios.get(item.url)
                                        .then(res => {
                                            bundle.ttl = item
                                            ttl_preview.value = original_ttl = patched_ttl = atob(res.data.content)
                                            parse_ports_ttl(original_ttl)
                                        })
                                        .catch(err => {
                                            console.log(err)
                                        })
                                        break
                                    }
                                }
                            }
                        })
                        .catch(err => {
                            console.log(err)
                        })
                    }
                })
                .catch(err => {
                    console.error('error getting bundle: ', err)
                })
            }

            function change_github_secret() {
                githubSecret.currentSecret = githubSecret.secret.value
                githubSecret.visible.value = true
            }

            function save_github_secret(newSecret) {
                localStorage.setItem(storageKeyGitHubSecret, newSecret)
                githubSecret.secret.value = newSecret
                githubSecret.visible.value = false
                errorMessage.value = ""
                toast('Github secret saved')
            }

            function show_customttl_dialog() {
                customTtl.visible.value = true
                if (isCustomTtl.value)
                    customTtl.content.value = original_ttl
                else
                    customTtl.content.value = ""
            }

            function save_customttl_dialog(newContent) {
                customTtl.visible.value = false
                ttl_preview.value = patched_ttl = original_ttl = newContent
                isCustomTtl.value = true
                parse_ports_ttl (original_ttl)
            }

            function toggle_port_selection(portId) {
                console.log('toggle port selection ', portId)
                const port = ports.value.find(item => item.id == portId)

                if (port)
                    port.selected = !port.selected
            }

            function copy_preview_ttl_to_clipboard() {
                console.log('copy_preview_ttl_to_clipboard')
                navigator.clipboard.writeText(ttl_preview.value).then(function() {
                    toast(selected_preview.value + " text copied")
                }, function(err) {
                    toast("Error copying text to clipboard")
                })
            }

            
            function getDiff() {
                let name1, name2;
                if (selected_bundle.value.id == ':custom:')
                {
                    name1 = 'a/custom'+ '/plugin.ttl'
                    name2 = 'b/custom'+ '/plugin.ttl'
                }
                else if (selected_bundle.value.ttl)
                {
                    name1 = 'a/' + selected_bundle.value.data.path + '/' + selected_bundle.value.ttl.path
                    name2 = 'b/' + selected_bundle.value.data.path + '/' + selected_bundle.value.ttl.path
                }
                else if (selected_bundle.value.data)
                {
                    name1 = 'a/' + selected_bundle.value.data.path + '/plugin.ttl'
                    name2 = 'b/' + selected_bundle.value.data.path + '/plugin.ttl'
                }
                else
                {
                    name1 = 'a/plugin.ttl'
                    name2 = 'b/plugin.ttl'
                }

                return Diff.createTwoFilesPatch(name1, name2, original_ttl, patched_ttl)
            }

            function patch()
            {
                // the patching is manual, can't reuse N3 too complex
                const lines = original_ttl.split('\n')

                const updateLineValue = (lines, lineIndex, name, newValue) => {
                    const toks = lines[lineIndex].split(' ')
                    let newLine = ""
                    let skipNext = false

                    for(const tok of toks) {
                        if (tok == '') {
                            newLine += ' '
                            continue;
                        }

                        if (skipNext) {
                            if (tok.endsWith(';')) // preserve the line ending even if we've skipped the value
                                newLine += ';'
                            skipNext = false
                        } else {
                            newLine += tok
                            if (tok.indexOf(':' + name) >= 0) {
                                newLine += ' ' + newValue
                                skipNext = true
                            }
                        }
                    }

                    return newLine
                }
                const patchPort = (patchInfo) => {
                    const port = patchInfo.port
                    const lines = patchInfo.lines
                    const indexLineIndex = patchInfo.indexLineIndex
                    const groupLineIndex = patchInfo.groupLineIndex
                    const symbolLineIndex = patchInfo.symbolLineIndex
                    const symbolPrefix = patchInfo.symbolPrefix
                    const indentation = patchInfo.symbolIndentation ?? '    '
                    const group = port.group

                    // ok new port found, add the config to the previous
                    if (indexLineIndex >= 0) {
                        // fix the index
                        lines[indexLineIndex] = updateLineValue(lines, indexLineIndex, 'index', port.index)
                    } else {
                        lines.splice(symbolLineIndex, 0, indentation + symbolPrefix + ':index ' + port.index.toString() + ';')
                    }
                    if (group.id == -1) {
                        // remove group
                        if (groupLineIndex >= 0)
                            lines.splice(groupLineIndex, 1)
                    } else {

                        if (groupLineIndex >= 0) {
                            // fix the index
                            lines[groupLineIndex] = updateLineValue(lines, groupLineIndex, 'group', group.name)
                        } else {
                            lines.splice(symbolLineIndex, 0, indentation + 'pg:group ' + group.name + ' ;')
                        }
                    }
                }

                let port = undefined
                let indexLineIndex = -1
                let symbolLineIndex = -1
                let symbolPrefix = ""
                let symbolIndentation = '    '
                let groupLineIndex = -1
                let lastPrefixIndex = -1
                let pluginId = null
                const usedGroupsId = []

                for(port of ports.value) {
                    let insidePort = 0

                    indexLineIndex = -1
                    symbolLineIndex = -1
                    symbolPrefix = ""
                    symbolIndentation = '    '
                    groupLineIndex = -1
                    lastPrefixIndex = -1

                    if (port.group.id >= 0 && !usedGroupsId.includes(port.group.id))
                        usedGroupsId.push(port.group.id)

                    for(let index = 0;index < lines.length; index++) {
                        const line = lines[index]

                        // search the plugin id (can't be on the first row)
                        if (pluginId == null && index > 0 && line.indexOf(':Plugin') >= 0)
                            pluginId = lines[index-1]
                        if (lastPrefixIndex == -1 && line.indexOf('@prefix ') >= 0)
                            lastPrefixIndex = index

                        if (line.indexOf(':port') >= 0) {
                            // ok new port found, add the config to the previous
                            if (symbolLineIndex >= 0) {
                                patchPort({
                                    port: port,
                                    lines: lines,
                                    indexLineIndex: indexLineIndex,
                                    groupLineIndex: groupLineIndex,
                                    symbolLineIndex: symbolLineIndex,
                                    symbolPrefix: symbolPrefix,
                                    symbolIndentation: symbolIndentation
                                })
                            }
                            insidePort = 0 // start of port descriptor
                            indexLineIndex = -1
                            symbolLineIndex = -1
                            symbolPrefix = ""
                            groupLineIndex = -1
                        }

                        if (insidePort < 2) { // finding a control input port port
                            if (line.indexOf(':ControlPort') >= 0)
                                insidePort++ // we need to find controlport and inputport
                            if (line.indexOf(':InputPort') >= 0)
                                insidePort++ // we need to find controlport and inputport

                        } else {
                            if (line.indexOf(':index') >= 0)
                                indexLineIndex = index
                            else if (line.indexOf(':symbol') >= 0)
                            {
                                // parse symbol name
                                let lineSymbolName = line.trim().split(' ')[1]?.replaceAll('"', '').replace(',','').replaceAll(';', '')
                                
                                if (lineSymbolName == port.symbol) {
                                    symbolLineIndex = index
                                    symbolPrefix = line.split(':')[0]?.trim() ?? ""
                                    symbolIndentation = line.replace(line.trim(), '')
                                }
                            } else if (line.indexOf(':group') >= 0) {
                                groupLineIndex = index
                            }

                        }
                    }
                }

                // if indexSymbolLine >= 0 we are handling the last port
                if (symbolLineIndex >= 0) {
                    patchPort({
                        port: port,
                        lines: lines,
                        indexLineIndex: indexLineIndex,
                        groupLineIndex: groupLineIndex,
                        symbolLineIndex: symbolLineIndex,
                        symbolPrefix: symbolPrefix,
                        symbolIndentation: symbolIndentation
                    })
                }


                // insert group extension prefix
                lastPrefixIndex++
                lines.splice(lastPrefixIndex, 0, '@prefix pg: <http://lv2plug.in/ns/ext/port-groups#> .')

                // add the groups
                if (usedGroupsId.length > 0) {
                    lines.push('')

                    for(let groupId of usedGroupsId) {
                        const group = groups.value.find(item => item.id == groupId)

                        if (group) {
                            lines.push(`${pluginId}:${group.name}`)
                            lines.push(`    a pg:InputGroup ;`)
                            lines.push(`    pg:symbol "${group.name}" ;`)
                            lines.push(`    pg:name "${group.label}" .`)
                        }
                    }
                }
                // join the lines
                patched_ttl = lines.join('\n')
                patched_ttl += '\n'
                send_enabled.value = original_ttl != patched_ttl

                if (send_enabled.value && selected_preview.value == 'diff') {
                    ttl_preview.value = getDiff()
                }
            }

            function set_selected_port_group(groupId) {
                console.log('set_selected_port_group ', groupId)
                const group = groups.value.find(item => item.id == groupId)

                if (group) {
                    for(let port of ports.value) {
                        if (port.selected) {
                            port.group = group
                            port.selected = false
                        }
                    }

                    patch();
                }
            }

            function on_port_dropped(e) {
                const p1 = ports.value[e.oldIndex]
                const p2 = ports.value[e.newIndex]
                const tmp = p1.index

                console.log('port dropped ', e, ' ', p1.index, ' <> ', p2.index)
                p1.index = p2.index
                p2.index = tmp
                console.log("new status ", ports.value)
                patch()
            }

            function show_rename_dialog (group) {
                console.log('show rename dialog')
                renameGroupDialog.group = group
                renameGroupDialog.label = group.label
                renameGroupDialog.visible.value = true
            }

            function rename_group(group, newName) {
                group.label = newName
                group.name = 'GROUP_' + newName.trim().replaceAll(' ', '_').replaceAll('-', '_').toUpperCase()
                renameGroupDialog.visible.value = false
                patch()
            }

            function switchPreview(preview) {
                console.log('switch preview ', preview)
                if (preview == 'patched') {
                    ttl_preview.value = patched_ttl
                } else if (preview == 'diff') {
                    ttl_preview.value = getDiff()
                } else {
                    ttl_preview.value = original_ttl
                }

                selected_preview.value = preview
            }

            function send_patch() {
                console.log("send patch")

                if (!githubSecret.secret) {
                    toast("Can't send patch! First insert the github key given to you.", "Sorry", 0);
                    return;
                }

                errorMessage.value = ""
                let body = '```path: ' + selected_bundle.value.data.path + '```\n```\n' + Diff.createTwoFilesPatch("original", "new", original_ttl, patched_ttl) + '```\n'

                const issue = {
                    "title": 'Groups for: ' + selected_bundle.value.label,
                    "body": body,
                    "labels": ['patch', 'groupify']
                }

                axios({
                    method: "post",
                    url: github_api.create_issue,
                    data: issue,
                    headers: {
                        "Authorization": "Bearer " + githubSecret.secret.value,
                        "Accept": "application/vnd.github+json"
                    },
                })
                .then(function (response) {
                    //handle success
                    console.log(response);
                    selected_bundle.value.patch_available = true
                    cache_bundles_status()
                    selected_bundle.value = undefined
                    toast('Post to github.com issue', 'Sending patch')
                })
                .catch(function (response) {
                    //handle error
                    errorMessage.value = response.message
                    console.log(response);
                });
            }

            onMounted(() => {
                console.log("onMounted: from composition")
                let items = null

                try {
                    items = JSON.parse(localStorage.getItem(storageKeyBundles));
                } catch(err) {
                    console.error('error reading local storage: ', err)
                    localStorage.setItem(storageKeyBundles, null)
                    items = null
                }

                if (items && items.length > 0) {
                    console.log("bundles found in localstorage #", items.length)
                    if (items[0].id == ':custom:') // remove saved custom
                        items.splice(0, 1)

                    // readd custom item
                    items.splice(0, 0, {id: ':custom:', label: 'Custom file', data: null, manifest: null, ttl: null, patch_available: false})
                    bundles.value = items
                }

                try {
                    githubSecret.secret.value = localStorage.getItem(storageKeyGitHubSecret);
                } catch(err) {
                    console.error('error reading local storage: ', err)
                    localStorage.setItem(storageKeyGitHubSecret, null)
                    githubSecret.secret.value = ""
                }
            })

            watch(selected_bundle, (old, newValue) => {
                console.log('selected plugin ', newValue)
                on_selected_bundle_changed ()
            })
            // initalize groups
            groups.value.push({id: -1, label: 'none', name: '<#none#>', color: "white", color: 'var(--no-group-color)'})
            const groupDefs = [
                {name: "MIX", label: "Mix"}, {name: "ENV", label: "Envelop"}, {name: "EQ", label: "Equalizer"},
                {name: "BAND1", label: "Band1"}, {name: "BAND2", label: "Band2"}, {name: "BAND3", label: "Band3"},
                {name: "BAND4", label: "Band4"}, {name: "BAND5", label: "Band5"}, {name: "BAND6", label: "Band6"},
                {name: "BAND7", label: "Band7"}, {name: "BAND8", label: "Band8"}, {name: "DLY", label: "Delay"},
                {name: "TAP1", label: "Tap1"}, {name: "TAP2", label: "Tap2"}, {name: "TAP3", label: "Tap3"},
                {name: "TAP4", label: "Tap4"}, {name: "TONE", label: "Tone"}, 
                {name: "GAIN", label: "Gain"}, {name: "CTRL", label: "Control"}, 
                {name: "CTRL2", label: "Control2"}, {name: "FILT1", label: "Filter1"},
                {name: "FILT2", label: "Filter2"}, {name: "TIME1", label: "Time1"}, {name: "LFO", label: "Oscillator"},
                {name: "ROOM", label: "Room"}, {name: "TYPE", label: "Type"}, {name: "MODE", label: "Mode"},
                {name: "1", label: "1"}, {name: "REV", label: "Reverb"}, {name: "3", label: "3"},
                {name: "4", label: "4"}, {name: "5", label: "5"}
            ]
            for(let i=0; i<32; i++) {
                var def = groupDefs[i]

                if (def.name == "")
                    continue
                groups.value.push({id: i, label: def.label, name: 'GROUP_' +  def.name, color: `var(--group-${i}-color)`})
            }
            return {
                selected_bundle,
                bundles,
                err,
                ttl_preview,
                selected_preview,
                ports,
                groups,
                el,
                renameGroupDialog,
                send_enabled,
                githubSecret,
                errorMessage,
                customTtl,
                toggle_port_selection,
                set_selected_port_group,
                get_plugin_list,
                on_port_dropped,
                patch,
                switchPreview,
                show_rename_dialog,
                rename_group,
                send_patch,
                change_github_secret,
                save_github_secret,
                save_customttl_dialog,
                copy_preview_ttl_to_clipboard,
                get_plugin_ports
            }
        }
    })
    

    app.use(PrimeVue.Config, {
        theme: {
            preset: PrimeUIX.Themes.Aura
        },

    });


    app.component('p-toolbar', PrimeVue.Toolbar);
    app.component('p-button', PrimeVue.Button);
    app.component('p-buttongroup', PrimeVue.ButtonGroup);
    app.component('p-listbox', PrimeVue.Listbox);
    app.component('p-splitter', PrimeVue.Splitter);
    app.component('p-splitterpanel', PrimeVue.SplitterPanel);
    app.component('p-dialog', PrimeVue.Dialog);
    app.component('p-inputtext', PrimeVue.InputText);
    app.component('p-password', PrimeVue.Password);
    app.component('p-message', PrimeVue.Message);
    app.component('p-textarea', PrimeVue.Textarea);
    
    app.component('p-toast', PrimeVue.Toast);
    app.component('p-confirmdialog', PrimeVue.ConfirmDialog);
    
    app.component("draggable", VueDraggableNext.VueDraggableNext)

    app.use(PrimeVue.ToastService);
    app.use(PrimeVue.ConfirmationService);

    app.mount('#app')
}

export default { run }