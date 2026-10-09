# upstream-sync-0991 — SAFE SETTLE / RYZEN2 migration

Written 2026-09-30 ~02:00Z per fabric-v2/org GO #2348. Read this fully before work. No new source changes on Dev1 after current pushed head. The ONLY portable .local file is this handoff; all other .local evidence stays Dev1. The remote task packets/results already live on ryzen2 and remain accessible locally. Do not restart accepted/requested tasks because completions go to the old session.

## Exact mission, Git and owners
- Repo Smarty-Pants-Inc/pi, origin https://github.com/Smarty-Pants-Inc/pi.git.
- Old worktree /home/paul/smarty/smarty-pants/worktrees/pi/upstream-sync-0991.
- Branch sync/upstream-v0.99.1; HEAD8c14be9775e59147c8f1e1c906a36b547c281fd4 (pushed verified). All own product work committed. Unrelated untracked .pi/fabric.json MUST NOT move/stage/alter; it is not our source.
- PR https://github.com/Smarty-Pants-Inc/pi/pull/92 OPEN hold+needs-security-pass. Closes Smarty-Pants-Inc/smarty-dev#2241. Model gpt-6.1-sol per #2236; PR body Owner fabric-v2. User authorized sync/commits/full tests/check/build.
- Base81eb324ff488db788ee2215e42c8ea406361287c; upstream0.99.1 d86654abb8862e201933517d6f1fce9f88dd117f; original merge22e52efd8c6776fe2fb33423ab66f96fa98131f3; empty retrigger0c524f0f7cda2f26d92266398fd6cb9640a7145f; reviewrepair8c14be97 current. git rerere enabled. Keep all146fork-only commits, pi#88 MAX50/LRU compaction, pi#89 lazytail resume. No separate patch manifest (smarty-model-integrity is a CLIProxy build, not Pi patch). Full146 rows and canonical64 interaction paths in existing PR body. Current full delta against81: credential38/guidance8/dependency27, no blocked/truncated paths; preserve classifications and update exact new head.
- fabric-v2 coordinator session:01a0cd9c-7c24-72d5-ae80-03d729baf983.
- dev-lead sole Pi fork landing/install integrator session:01a0ec33-fe37-75f3-908a-9bdaebb7f0d1. Hand exact new head directly to BOTH. No force/merge/approval by lane. dev-lead installs exact landed artifact, childprobe, rollback81.
- Old parent Fabric id session:01a0eed9-fb07-7649-97a5-70e8de42f32a; replacement MUST register own exact cwd/origin/HEAD and notify fabric-v2/coordinator.
- Remote task coordinator (Light) session:01a0efd7-9fd4-7490-92de-4cede247dcda.
- FollowUp + mesh shadow fleet.work.smarty-dev.2241 for ACK/ETA/ask/handoff; data{ref:"Smarty-Pants-Inc/smarty-dev#2241",key}. No GH acknowledgement/status chatter.
- On ryzen2 NO GitHub credentials. Tell fabric-v2 PUSH <branch/head/path> or COMMENT <file/path>, it performs writes from ryzen1. Keep one Git owner in lane. Only one new head plus ONE whole-round response after checks, not one per finding. Do not retry QUEUED outbox writes.
- Principal approvals: upstream contact NOT authorized. All outside reports drafted afterinstall forPaulYES via fabric-v2, security-relevant via upstream SECURITY CONTACT, not publicissues.

## Current status and ETA
8c round1 source+checks/consumer/realPi/nativeTTY independently PASS for readiness, but CURRENT review/astra and review/security both FAIL same8c on uncovered scenarios. All old26 repaired and remain preserved. New census =16 unique blocking findings (3P1/13P2) plus rotatinglog hardening. No accepted residual/scope cut. Ready-re-review provisional ~05:00Z, authorized box ~07:00Z. Cost parallel source45 + collision-dependent integration45 + exactchecks/proofs/audit45 + reviewer margin; earlier03:10 no longerfits and coordinator informed immediately. Keep moving on results, no waiting silently.

Current review comments (full text appended below):
- Astra round2 https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5902278362
- first same-head security https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5902288706 (F16/F17/OAuth+catalog +log)
- comprehensive security https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5902441290 (14security blockers overlaps Astra7; plusSDK/classifier2).
- CI8c success https://github.com/Smarty-Pants-Inc/pi/actions/runs/36653790287/job/109693579717; publish/generate/emergency skipped notPASS.
- Existing lane round1 response/WAIT comment5900139015 https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5900139015. Registered old WAIT security=success8c nextcheck01:50 is MET by failure; actively repairing, no restart. Edit once afternewhead combinedresponse oronewhole-roundcomment with newexacthead WAIT. Budget ONLY one comment/round. Previous queued outbox2106 oldWAIT accepted; NEVERresend.

## In-flight remote work — do NOT restart
All task sources are isolated clone directories under /srv/scratch/paul/tasks/fv2-upstream-sync-0991/. They share read-only objects /srv/scratch/paul/tasks/pi92-round2/packet.git (full HEADbundle, base/upstream objects included). No auth/.pi/fabric.json/native mesh/parent.local copied. Each .local/assignment.md is complete exactguard/ownership/tests packet. Newgroups have .local/astra-round2.md and security-round3.md fullreviews. First4 have security-round3.md copied where extensionapplies.

First requests -0142 explicitly REJECTED (wrong root pi92-round2) with no children. Corrected -0149 all ACCEPTED01:50Z. No duplicate active worker. All eight -0155 ACCEPTED: six01:55Z (pico/sandbox/nested/grant/callback/registry), SDK/classifier02:00Z. All12 requests accepted; worker guard/validation receipts still pending. Coordinator told impendingmove, copy completions to fabric-v2 and keep oldreceiver until replacementregistered. Source writers may still run; never copy active mixed bytes. Get SOURCE RELEASE/result then inspect hashes/fullfiles and integrate ONLY exclusive paths.

Result protocol: /srv/scratch/paul/tasks/fv2-upstream-sync-0991/<task-id>/result.md plus source-owned cwdGROUP/.local/round2-GROUP-result.md. If resultlocation differs use coordinator returned actualpath. Newagent polls these localfiles at most1/min only fallback because completion maytargetoldsession. Check result status/guard/model/process nice receipts, not just accepted message. No children may spawn or Gitmutation; parent integrates code exactpaths (no taskcommits expected). NoGH credentials onremote. npmci--ignore-scripts/offlinebuild/targettests allowedREMOTEnice19; parent exactfullsuite/check. Models Solmedium/high prescribed, namedreview/max allowed by coordinator.

Task table and exclusive files:
| Task id | Prepared cwd suffix | Findings | Exclusive source/tests | Status |
|---|---|---|---|---|
| pi92-r2-private-output-0149 | private-output | F16P1 +log | coding-agent/src/extensions/codemode/execute.ts; extensions/mcp/tools.ts,log.ts; NEW coding-agent/test/security-round2-private-output.test.ts,security-round2-mcp-log.test.ts | ACCEPTED01:50 /30min |
| pi92-r2-private-config-0149 | private-config | F17P1 | coding-agent/src/extensions/mcp/config.ts,cli.ts; NEW coding-agent/test/security-round2-private-config.test.ts | ACCEPTED01:50 /30min |
| pi92-r2-oauth-bounds-0149 | oauth-bounds | F21 | mcp/src/oauth/discovery.ts,flow.ts,errors.ts; optionalNEWresponse.ts; auth-provider.ts ONLYifneeded; NEW mcp/test/security-round2-oauth-bounds.test.ts | ACCEPTED01:50 /30min |
| pi92-r2-catalogue-bounds-0149 | catalogue-bounds | F23,F20,F26 | mcp/src/client.ts; transports/streamable-http.ts ONLYclosejoin; NEW mcp/test/security-round2-catalogue-bounds.test.ts,security-round2-client-retirement.test.ts | ACCEPTED01:50 /extended45min |
| pi92-r2-pico-owned-merge-0155 | pico-owned-merge | F15P1 | agent/src/harness/pico3/view.ts,legacy-tracker.ts; NEW agent/test/harness/pico3/security-round2-owned-watch.test.ts | ACCEPTED01:55 /40min |
| pi92-r2-sandbox-store-close-0155 | sandbox-store-close | F19,F24 | codemode/src/runtime/host.ts; NEW codemode/test/security-round2-store-close.test.ts | ACCEPTED01:55 /40min |
| pi92-r2-nested-native-custody-0155 | nested-native-custody | A11,F18 | coding-agent/src/core/nested-tool-calls.ts,core/tools/tool-definition-wrapper.ts,core/agent-session.ts; NEW coding-agent/test/suite/security-round2-nested-custody.test.ts | ACCEPTED01:55 /40min |
| pi92-r2-grant-revision-0155 | grant-revision | F22 | coding-agent/src/extensions/mcp/oauth.ts; mcp/src/oauth/provider.ts; NEW coding-agent/test/security-round2-oauth-revision.test.ts | ACCEPTED01:55 /40min |
| pi92-r2-callback-retirement-0155 | callback-retirement | F25 | mcp/src/oauth/callback.ts; NEW mcp/test/security-round2-callback-retirement.test.ts | ACCEPTED01:55 /40min |
| pi92-r2-registry-pending-0155 | registry-pending | F13 | coding-agent/src/extensions/mcp/index.ts; NEW coding-agent/test/suite/security-round2-mcp-registry.test.ts | ACCEPTED01:55 /40min |
| pi92-r2-sdk-virtual-resume-0155 | sdk-virtual-resume | Astra8 | coding-agent/src/core/sdk.ts; NEW coding-agent/test/suite/security-round2-virtual-resume.test.ts | ACCEPTED02:00 /40min |
| pi92-r2-classifier-cancellation-0155 | classifier-cancellation | Astra9 | ai/src/api/llama-cpp-classify.ts; NEW ai/test/security-round2-classifier-cancellation.test.ts | ACCEPTED02:00 /40min |
All paths above under packages/. Safely inspect git diff --name-only+untrackedproductonly in each child; bring onlyauthorizedchangedfiles/reports/receipts into integration checkout. Nevercopywhole.git/.local/node_modules fromchild.

### Important pending steer ownership agreements
Coordinator was asked to forward these to ACCEPTED workers (not restart):
1 OAuth-bounds conditional oauth/provider.ts ownership REVOKED; grant-revision exclusively owns provider.ts. Flow remainsOAuth-bounds, grant worker prohibitedflowwrites, reports precise parentintegrationhunk if required. Integration must reconcile typed signal/revision APIs end-to-end (read callers).
2 Catalogue owner scope extendedF20/F26+HTTPclose, sameclientwriter, box45min. Duplicateactive incomingID reject beforecallback, identitycleanup, sharedclosecompletion installedBEFOREcallback/clear; realstderr/stdio descendant +HTTPDELETE joins. No otherchild touchesclient/HTTP.
3 Config F17 strictercomprehensive review: preserveexistingmanaged modes ONLYsafe/explicit; do NOTsilentlyretainpublic secret-bearingfile. Refuse unsafe existing literalwrite redacted/actionable beforepersistence, don'tchmodmanagedpolicy silently. Test safemode600literal, managed750/640referenceordinary, publicliteralsecretrefusal. Projectliteralwarning (notcompatremoval) loaded/CLI-visible redacted, nofakewarningAccept/ref/global.
Latest forwarding ask sent01:57ish transportack2a26f7d6-fbbe-41be-ad9c-70a09a94340a. Verifycoordinatorsteers delivered before acceptingconflictingresult.

## Acceptance ledger (also supplied fullpackets)
Each actual reviewed sequence AND the case stillallowed needs executablebefore-effect+candidatepublicpath test. Not merely missingbuild/setupfailure. Test comments#2241. All runtime trust boundaries retained, no any/inlineimports.
- F15 ownkeys watched-generation separatecommits: no inheritedtarget/deletion comparison; reservedownkeysdata; ordinary edits/arrays/deletes remain.
- F16 CodeModespillrealexecute under022: nativeprivate0700 mkdtempdir+wx0600file, no chmodsharedtmp; fullOutputPath+offsetreads andwritefailure/untruncatedcontrolpreserved. MCPsaverconsistentprivateexclusive, logsnewdir700/newfile600rotation, managedexistingbesteffort.
- F17 freshglobal/projectdirs700/files600, exclusiveNEWcollision, existingunsafe literalrefusal; managedreferencecontentmodepreserved; projectliteralwarningredacted/realcaller-visible, ordinaryAccept/envcmdreferencesnotwarned.
- F13 extensionregister/remove/replace/disable BEFOREconstruct: identityrevisionfence independentvisiblemap, pendingownership beforefirstawait, staleconnectionretire; shutdownjoinscreation, stale toolsnotcallable, healthyunrelatedserverworks.
- A11 sequentialwrite excludes parallelread/bashcousin BOTHarrivalorders beneath exclusiveancestor. Parallelcompositeparents/reentrantancestor stillprogress; afterhooks retainlease; notonlywriter/writer.
- F18 native model SDKparent startsunawaited ctx.executeTool: acceptedchild/realatomicwrite/afterhookjoinBEFOREresult/idle/abort; postretirementadmissionreject; nestedparentcontrolretained.
- F19 HOST store snapshot/value+effectiveaggregate256Ki/1Mcharacter budgets, replacements/deletions/repeatedruns/arbitrarykeys; validforgedmetadata oversized blocked outsideguest.
- F20 duplicateactive incomingMCPIDs rejectedbeforecallback; identitycleanup retainsfirstcontroller, cancel/close abort originalacceptedcooperativework; ordinaryIDswork.
- F21 OAuthnetworkbodyreceivedbytesbeforedecode onmetadata/register/token/errors/discard, boundeddiagnosticprefix+readerretire, deadlineheaders/body +callercancel boundedcandidatechain; normalstateURL/tokenredirect/grantcontrols andhumanbrowserwaitpreserved. Do notswallowlimit/deadline asdiscoverymiss orrefreshfallback.
- F22 perattempt/grantrevision authority fencesoldrefresh/supersededbrowser saves ANDinvalidations; separateprocesscredentialstores/localfakeHTTP; logoutfences preserved, genuinelynewsignin/refreshnormal.
- F23 catalogueaggregatebytes/items/pages BEFOREappend inclUTF8/singlepage, wholedeadline notresetpage/progress, perpendingbodycancel; legitimateboundedmultipage/duplicatecursors/unrelatedcalltimeoutdisableprogress remain.
- F24 awaitedreentrant sandboxclose initiatesretirement andsettles/rejectsselfjoin; externalclose MUSTstillwait effects/hooks, noF4regression.
- F25 stopaccept/ownedcallbackrawsocketretire+join closure; validcallback andcancel withpreconnection/incompleteHTTP finishbounded; propercallbackresponsespreserved.
- F26 clientconcurrent/reentrantclose samecompletion setbeforeemit/clear, runtimecannotrecordemptyjoin; HTTPDELETEclose samecompletion, stdiodescendantretirementjoin.
- Astra8 SDKfresh runtime+resourceloaderqueuedvirtualregistration flushedBEFOREmodelrestore; actual nextprompt routerselected notmanualpreregister; normalphysicalfallback/custodySensecontrols.
- Astra9 coldtokenization cancellationindependentA/B eitherabort, otherlive; cancelledwaiterprompt, warmcache+failedretry remain.
All16 mapping above. Original26 checkfullsuite remains. Mechanical symbols/API/configregistration/pathscope verified.

## Next actions after replacement starts
1 Register exactmodel/cwd/origin/HEAD, ACKfabric-v2+shadow, tellremoteLightreplacementid. Checkaccepted/resultlocalfiles and pendingsteer receipts; doNOTretryacceptedrequests. Iffailuremissingresult askONCEcoordinator, accountETAcost.
2 Preserve exclusiveintegration. Fullread returnedsource/test+allnamedcallers beforeedit. Useoneexacteditbatch/file forparentfixes; noGitstash/reset/clean/addall/force. Newtests explicitlystageownpaths only. Base8csourceclean exceptunrelated.fabric.
3 Integrate releasedtaskpaths, reproduceactualbeforeeffects using isolated8c source clones/newtests, inspecttestfailrootnotjustexit. Eachnormalcounterexamplecandidatepass. Targettests remotepackageroot via node ROOT/node_modules/vitest/dist/cli.js --run; agentPico3tests Vitestasexistingpackage.
4 Root npmci--ignore-scripts, npm run check FULLoutput fixALLwarnings/infos/errors. It formats files; fullread diff beforeadoptingexactformat bytes. npm run build:offline (authorized), ./test.sh isolatedhome/noauth env (userexplicitfullsuite). NEVERrawfullvitest/npmtest. npm run check:package-install ifcrosscutnewSDK/types risk. No dependencychangesunlessrequired; doNOTrunlifecycle. Fullsuitealreadytestsconsumer/TUI/scripts; packagebinaryprereq unchangedpassing probe don'trerunnetworkbuildunchanged.
5 Exact source+test SHAmanifest and committedblobbinding, no mixlivechildbytes. Capturefulllogs/concisecounts, archiveownscratch only. Onnewhostrunheavychecksnicelylocal; no need forge-run hop.
6 AffectedrealPi proof stillneeds Dev1fleetmesh (old authorizedoneextraPi nice19). Ask fabric-v2 to run/copy approved previous proof scripts from old .local (pathsbelow) against newexactcheckedartifact; never actualcredentials/mesh in/tmp. Scratchagent/HOME/mesh/tmp UNDER.local, noauthtokencopy, emptyruntimeauthobject/commandreferencesonly. Allfiveextensions load, actualfabricexec42, guardrealrefusal, bettercompaction, lazytail identicalcontext/coldentries, CodeMode default-off. NewCodeModeprivatespill/nativechildren realpath controls fromtests, actualaffectedproof ifneeded. Do notbootproofPi onryzen2 withwrongsharedfleetmesh. OldPTYproofuserpath unchangedexceptSDK model doesn'tchangeinteractivehistoricstatus; existingnativeTTY pinnedproofstillvalidforunchangedrendering; rerunifsourceaffectsTTY.
7 Independent ready-re-review audit via localtaskagent /remoteLight Solhigh/maxauthorized, boundedexclusiveoutput. ReadALLnewreceipts/source/provenance+nativevisual ifchanged; beforeclaimPASS. Namedsecurityactualdev-lead rerun exacthead, notlaneownclearance.
8 Single commit (samebranch) allrepairs, exactoldforkretention/classifieddeltaaudit, one new head. Onryzen2 send PUSH <branchhead/localrepo> to fabric-v2. ONEwhole-roundCOMMENT file withall16/log fixes+before/allowedcountercases/actualcheck/proof/auditlinks/model#2236. Include newWAITgrammarexacthead/newtime. Telldev-leadnewhead +fabric-v2shadow andprivateupstream-originreport. No secondhead withoutreason/failure. Keepprivateoriginlist OFFpublicevidence.
9 StaythroughCI/namedreviews, furtherfindings wholepath+counterexamples, onehead/round. No scopecutwithoutcarryingissuefirst. Mergequeue bydev-lead; install exactlandedartifact+rollbackboundary below. Uponmerge archive.localcomparecounts/reportmerge/cleanupONLYownscratch/stopownPi/tab (factoryretireswithin6h).

## Prior proof/evidence retained on Dev1 and pinned publicly
Round1 56paths/allcommitted8cblobs matchmanifest; independentPASS READY-FOR-RE-REVIEW ONLY, notsecurityclearance/landedinstalled.
- Root check0 (nofixes), buildoffline0/full./test.sh0:7073VitestPASS912intentionalSKIP+25scripts+1182TUI, nofailurewarnings. SDK/built/unbuiltCLI consumers genuinePASS. N1oldfixtureecho/run_toolsexpectedfailure correctedtoactualecho/helper; final2supersedesinitialfailedsuite.
- Manifest SHA5172d546add3c7550b57bcf75695b339b704fe14248f32dec65dbedc2b34c073. RawtestsSHA6f0f59919462336f4de8284aa4847a64dd56942a97a782236d528e8116341e1f. Distrestoredfromsamefinal2tarzero content/mode/mtime diff exceptremoteUID.
- RealPi actualfiveextensions/Fabric42/guardrefusal/extensionbettercompaction/lazycontext44711bytesSHA7d653297814d9639362c0d1a7d565daa951b59665c4f855383ea7eb6ba236717+511cold; Codemode registeredinactive. Scratchall.local andemptyruntimeauth.
- NativeactualPTY100x42 keyboardlow->real!printfINTERVENING->medium->adjacenthigh->settingslighttheme preview/commit->!printfAFTER->exit. Fixedfirstlowstayslow; baselinefirstlowrelabelshigh. VideoSHAe31a9b4c446a5414ed3a2d6aabbdac06da807eec2db605cf5289a809a70f80a8. Independentnativefullsheet/finalPNG/GIF+transcriptPASS.
- Before-effectgenuine originalstdio survivortrueafterclose65ms vsfixedfalse362ms; nativeURL/token307308secondorigin delivery; JSON/UTF8oversize accepted/originalJSON/error/SSEnotretire1500ms; A11mixedroots/recursive/cousin originals5FAIL vsfixedPASS. OldstdioPromiseidentityfailure DOESNOTcountsurvivor; genuineprobe laterrepaired evidence. Oldtokenrefreshoriginal assertionnotreached, fixedbothrefresh/exchangeverified.
- Pinned public branch16d791613bf9a68a6fcf0c60ae12894c5a6a2f69 (gitpushnoRESTbudget): https://github.com/Smarty-Pants-Inc/pi/blob/16d791613bf9a68a6fcf0c60ae12894c5a6a2f69/pr-92-round1/README.md links fullcheck/tests/manifest/video/sheet/realPi/audit/classifierdelta. RepoPUBLIC, evidenceallfake/redactedchecked; doNOTpublishprivateupstreamreport/credentials/config.
- Dev1local .local/security-final2/ fullcheck/testlog+dist.tar.gz/checkedsource/sha; .local/round1-verification.json, round1-commit.json; .local/round1-acceptance-audit.md3998chars SHAd5d13d21f5453a613a17f61befdf4e506a27d16d374bdd84f6e34b10fc5b01f0.
- Old proof scripts .local/{prepare-proof.mjs,seed-proof.mjs,proof-observer.ts,run-proof.mjs,inspect-proof.mjs} supportSYNC_PROOF_ROOT; .local/proof-final/artifacts/result.json. These files doNOTmove; requestfabriccopy/runningonlyownedscript ifneeded, neveractualscratchHOME/credentials.
- ActualPTYscript .local/capture-tui-proof.py (setsid+TIOCSCTTY necessary; noCTTYfirstfailureharnessnotproduct). .local/render-tui-proof.mjs,verify-tui-render.sh remotePlaywright/xtermactualPTYtimingwebmGIFsheet; useprivatejobapt-getdownload/dpkg-debextract/libPATH/fontconfig ifbrowserdepsmissing, NOglobaladmininstall. Oldpaths .local/tui-proof/artifacts, tui-proof-before2/artifacts, tui-proof-video, tui-proof-before-video.
- Old own ONLY/tmp dir /tmp/tmp.BkwiYWzX6Q onDev1 (containsround2bundlepackets andpriorownsnapshots). No/tmpglobs; don'tdeletebeforecopiedneededartifacts. NoownproofPisrunning, allnormalexit.
- Fullforksyncconventionsdocs/forks.md/bin/smarty-fork-sync FULLread prior; readinstalleddocsifnewenvironment unavailable askfabric-v2, doNOTguess. Branchsync/upstream, rerere, syncdelta comment, canonical64paths/classifiedcred/guidance/lock hunks retained.

## SQLite install / rollback — exact boundary, do not weaken
- Exact81 runtime cannotopen durableSQLite schema2; codeonlyrollbackNOTdata-compatible. dev-leadACCEPTED pairedexact81artifact +preupgradev1consistentSQLitebackup afterdrain, integrity_checkok and SELECTversionFROMdurable_schemaWHEREsingleton=1 ==1 (NOTPRAGMAuser_version).
- Boundedinventory00:04/00:07foundNO Pi durableDB underagentmaxdepth8/runtime4/sharedagent6/exactlivePiFDs. ExternalSDKcustompaths/deeper/symlinks/nonpiSDK/otherhostsunknown, conditionalinstallgate. OrdinaryCLIJSONL default, SQLiteoptin callerpath.
- ONLYobserved DB /home/paul/.local/share/smarty-dev/fabric-staging/10583515134/live/receipts.sqlite is UNRELATEDsharedFabric receipts, no durable_schema, liveingress/githubfactorywriters; EXCLUDE fromPiDBsnapshot/restore, doNOTquiescesharedfactory/ingress.
- Anyactualdurablepath: recordapplicationwriterowner/scheduler, gatesubmissions+scheduledreopen, draincommits/closeallmainWALSHMholders andmaintainhold throughsnapshot,activation ANDrollbackdecision. SQLite .backup notcplivemain, timestampedpath+SHA/integrity/schema1 paired81; no versionloweringguardbypass. ReleasedwritespostbackupLOSTonrestore, soifwritersresume blockautomaticrollbackuntilpreservationdecision. No backup/quiesce/installperformed bylane.
- Genericpi-runtime/rollbackobservedpoints672545d28ed809696cfac5192194b2e963c7cf93 NOT81, dev-leadexplicitlyretainrequested81.
- Fullprivateoldinventory/reviewdurablereceiptsremainDev1; sufficientboundaryhere. No deploy/newresource/admin authorization beyondreviewedmergedreleaseexistingresource. Install/devlead ownsgate.

## Upstream provenance list below (COPY to new .local/upstream-origin.md)
Preserve completeoriginal26rowsbelow; appendnew16round2 findings withseverity/exactd866fileline/forktouch/minimalmaintainerrepro. Childreportsownreadonlyattribution. Mark newerA11/F24 changesforkinteraction vsinherited accurately; don'tmarkwhole-fileunchangedifround1touchedit. No upstreamcontact. ThelistNOTpublicevidence.

```markdown
# Pi v0.99.1 findings for a later maintainer report

Target: `earendil-works/pi@d86654abb8862e201933517d6f1fce9f88dd117f`.
Reviewed fork head: `0c524f0f7cda2f26d92266398fd6cb9640a7145f`.
Repair head: `8c14be9775e59147c8f1e1c906a36b547c281fd4`; all 56 committed blobs match the independently audited checked manifest.

This is provenance and bounded reproduction data, not an upstream submission. No upstream contact is authorized. The five distinct original P1s are F1/F2/F3/A1/A8; Astra also elevates the already tracked F5 overlap (A2) to P1. The table preserves both labels rather than losing the severity change. After install, fabric-v2 prepares one grouped report for Paul's approval, using the upstream security contact for security-relevant findings. Never infer upstream clearance from default-off features.

“Unchanged” means exact Git blob equality between the reviewed fork and the target. “Inherited statement” means the file differs, but the cited defective statement is present upstream. The fork-only depth regression is not attributed to upstream. Exact blob receipts: `security-upstream-comparison.json`; implementation/test receipts are separate and must not be confused with provenance.

| Finding | Severity | Upstream target file:line | Did our fork touch the defective code? | Minimal maintainer reproduction |
|---|---|---|---|---|
| F1 SDK nested hook chain | P1 | `packages/coding-agent/src/core/agent-session.ts:711–712` | Inherited statement; fork changed surrounding custody/dispatch code, not the private-hook substitution. | Install public Agent authorization and result-redaction hooks. Compare direct calls with the same tool reached through Codemode; the nested route skips those hooks. |
| F2 completion validation | P1 | `packages/codemode/src/runtime/host.ts:49–54,201–207,242–272` | No; whole runtime file unchanged. | Public sandbox completion whose store metadata serializes to a non-array must return a sandbox error. Baseline instead throws in its host listener and leaves completion unresolved. |
| F3 generation merge custody | P1 | `packages/durable/src/harness/generation.ts:288–304` | No; whole generation and Chord tracker files unchanged. | Send two partial tool-argument objects through separate public GenerationTask flushes. Add an own object-valued reserved prototype key in the second; observe process Object prototype mutation instead of owned document data. |
| F4 host effect retirement | P2 | `packages/codemode/src/runtime/host.ts:190,210–239,248–272` | No in runtime; fork's built-in atomic write implementation differs and makes the effect concrete. | Gate a real built-in write/hook, then abort or return without awaiting it. Baseline sandbox/close settles before the effect/hook; releasing the gate changes the file afterward. |
| F5 native output bounds (also A2) | P2 / A2 P1 | `packages/codemode/src/runtime/host.ts:183–188`; `worker.ts:77–84` | No; whole runtime files unchanged. | A finite run emitting 5,000 empty text items retains them all. Reusing a bounded string for repeated text/image emission likewise grows native retention beyond VM heap limits. |
| F6 logout custody (also A4) | P2 | `packages/coding-agent/src/extensions/mcp/oauth.ts:137–172,238–259`; `packages/mcp/src/oauth/provider.ts:91–98,138–152` | No; whole files unchanged. | Pause a refresh response in one credential-store instance, logout through another, then release refresh. Baseline recreates the deleted grant. A genuinely new post-logout sign-in must remain allowed. |
| F7 callback handler boundary (also A6) | P2 | `packages/ai/src/auth/oauth/callback-server.ts:78–80,106–115`; `packages/mcp/src/oauth/callback.ts:66,117–118` | No; whole callback files unchanged. | While login awaits its local callback, send a malformed request target such as `//[`. It must receive 400 while login remains pending, then accept a valid state-bound callback; baseline handler throws/rejects unobserved. |
| F8 metadata URL admission | P2 | `packages/mcp/src/oauth/types.ts:114–118,144`; `flow.ts:153–164` | No; whole files unchanged. | Supply non-web authorization endpoint metadata and request sign-in. Baseline passes it to the native opener. HTTPS and explicitly supported loopback HTTP must still work. |
| F9 abort during bind | P2 | `packages/ai/src/auth/oauth/callback-server.ts:118–134`; `oauth/radius.ts:153–185` | No; whole files unchanged. | Abort login while callback listener binding is awaiting completion. Complete binding and verify cancellation settles and retires the listener; baseline misses the earlier abort. |
| F10 late routing/compaction | P2 | `packages/coding-agent/src/core/agent-session.ts:781–800,3031–3047`; `model-runtime.ts:1000–1007` | Inherited unchecked await/controller statements; fork changed custody, deadline and settlement machinery around them. | Pause a virtual route, abort its Agent, then return a smaller-window fallback. Baseline publishes router state and can start an uncancelled summary request; normal live routing/manual compaction must remain valid. |
| F11 HTTP body admission (also A3) | P2 | `packages/mcp/src/transports/streamable-http.ts:240–242,315–320` | No; whole transport/client files unchanged. | Return oversized/chunked JSON or error bodies from a controlled MCP server. Validate byte caps before buffering and cancel body work when its request times out; an unrelated valid request must survive. |
| F12 process-group retirement (also A5) | P2 | `packages/mcp/src/transports/stdio.ts:105–108,160–176` | No; whole transport file unchanged. | A cooperative wrapper exits while its same-group descendant ignores TERM and closes inherited pipes. Close must retain bounded group escalation rather than settle with the descendant alive. |
| F13 startup client ownership | P2 | `packages/coding-agent/src/extensions/mcp/runtime.ts:362–391,453–459` | No; whole runtime/bootstrap files unchanged. | Pause actual MCP initialization/discovery, retire the connection owner, then release setup. Close must cancel/join the unpublished client and never publish it afterward. |
| F14 superseded client ownership | P2 | `packages/coding-agent/src/extensions/mcp/runtime.ts:291–296,453–459` | No; whole runtime file unchanged. | Keep an old session GET stream live, return 404 to one POST, establish replacement, then close the owner. All old and replacement clients must retire, including repeated replacements. |
| A1 credential redirect policy | P1 | `packages/mcp/src/oauth/flow.ts:172–188` | No; whole flow file unchanged. | A controlled token endpoint returns 307/308 to a second origin during exchange or refresh. The collector must receive no credential-bearing request; normal token responses remain valid. |
| A7 ChatGPT error callback state | P2 | `packages/ai/src/auth/oauth/openai-chatgpt.ts:102–111` | No; whole OAuth implementation unchanged. | A wrong/missing-state error callback must leave login pending. A matching-state error may reject, and a matching success may complete. |
| A8 released SQLite schema upgrade | P1 | `packages/durable/src/storage/sqlite/migrations.ts:20–27,51–60,88,119–122`; `storage.ts:700,736–738` | No; whole migration/storage files unchanged. | Create a database with the actual fork base's released schema version 1, then reopen with v0.99.1 and continue owner/submission writes. Baseline skips rewritten version-1 additions and references missing columns. |
| A9 owned journal array depth | P2 | Not present upstream; fork `packages/coding-agent/src/core/owned-session-entries.ts:12–14` | Yes; fork-only merge regression restoring a depth guard but counting array length as a child. | Append/reopen a strict JSON custom entry ending in an empty array at depth 512. Preserve base acceptance while rejecting genuinely deeper values and accessors. |
| A10 explicit empty defaults | P2 | `packages/coding-agent/src/core/settings-manager.ts:223–227,234–236` | No; whole settings file unchanged. | Layer global read/bash with project empty list, then layer global empty with project +codemode. Actual loadouts must preserve explicit emptiness, including applyOverrides. |
| A11 nested sibling exclusivity | P2 | `packages/coding-agent/src/core/nested-tool-calls.ts:201–216` | No; whole nested runner unchanged. | Gate sequential write alongside parallel read/bash; neither may overlap its exclusive sibling. Sequential descendants must serialize without waiting on their ancestor's own lease. |
| A12 explicit structured null | P2 | `packages/agent/src/agent-loop.ts:879–880` | Inherited null-coalescing statement; fork changed other loop attribution/batch code. | Override a structured tool result with null, with and without a text-content override. Null must be retained as data/redaction rather than treated as omission. |
| A13 migration-only publication | P2 | `packages/durable/src/session/transaction.ts:942–947,961–963` | No; whole transaction file unchanged. | Watch an old-version document, commit its schema migration without another edit, and verify a version-reset publication. A current-version no-op must remain quiet. |
| A14 arbitrary store keys | P2 | `packages/codemode/src/runtime/host.ts:40–54` | No; whole runtime file unchanged. | Store an own reserved string key, persist writes, then load after resume. Both snapshot and write conversion must preserve an own data property without changing host dictionary prototypes. |
| A15 historical status rendering | P2 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3723–3731` | Inherited mutable-text closure; fork changed other interactive rendering. | Display two separated statuses, invalidate via theme preview/change, and verify each keeps its original text. Adjacent statuses must still coalesce. |
| A16 Mini installation identity | P2 | `packages/ai/src/auth/oauth/openai-chatgpt.ts:233–237`; `packages/coding-agent/src/experimental/mini/worker/models-service.ts:57–65` | No; whole files unchanged. | Choose advertised ChatGPT login through Mini selector/worker. Its OAuth call must receive the worker host's stable globally persisted installation ID before browser opening. |
| A17 binary prerequisites | P2 | `packages/coding-agent/package.json:44` | Inherited missing-prerequisite script; fork changed other package metadata/scripts. | Remove only new Codemode/MCP build outputs from a base-style built checkout, invoke package-level build:binary, and verify both prerequisites are built before the CLI worker/binary. |

Validation state: all 26 candidate regression gates pass on the checked 56-path repair snapshot, including the full `./test.sh`, root check, packaged consumers, actual base-module SQLite upgrade and public session/store resume. `.local/before-effects` directly confirms original unsafe URL/redirect delivery, oversized/non-retiring HTTP bodies, nested overlap and surviving stdio descendant; the original redirect exchange assertion stops before refresh, while both fixed exchange and refresh are tested. Earlier STDIO Promise-identity failure is not counted as a survivor reproduction. Real Pi fleet/compaction/lazy-resume proof passes; real TTY status/theme video/contact sheet passed native independent inspection (`ACCEPTANCE_AUDIT: PASS — READY-FOR-RE-REVIEW ONLY, all26`). Named security/review clearance, landing and installation remain separate gates. No additional upstream contacts, secrets, or private authentication configuration are included.

```

## Full current acceptance ledger
```json
{
  "baseHead": "8c14be9775e59147c8f1e1c906a36b547c281fd4",
  "reviewComments": [5902278362, 5902288706, 5902441290],
  "acceptance": "All16 unique blockers, plus MCP log creation hardening; preserve previous26 repairs/all146fork commits. One new head and whole-round response; exact-head named security and CI before landing.",
  "readyEta": "2026-09-30T05:00Z provisional; authorized box07:00Z",
  "checks": [
    {"id":"F15","severity":"P1","owner":"pico-owned-merge","check":"Actual watched generation across separate commits treats reserved own keys as data, no inherited merge targets/deletions."},
    {"id":"F16","severity":"P1","owner":"private-output","check":"Actual CodeMode spill under022 creates private0700 directory/exclusive0600 file; full content accessible only through intended owner path."},
    {"id":"F17","severity":"P1","owner":"private-config","check":"Fresh global/project0700+0600, redacted literal-project warning and unsafe existing secret-mode refusal; safe managed/ref configs retained."},
    {"id":"F13","severity":"P2","owner":"registry-pending","check":"Register/remove/replace/disable before construction cannot publish or leak stale transport; shutdown joins pending creation."},
    {"id":"A11","severity":"P2","owner":"nested-native-custody","check":"Sequential child excludes parallel read/bash cousin in both arrival orders including exclusive ancestor; parallel composite reentry still works."},
    {"id":"F18","severity":"P2","owner":"nested-native-custody","check":"Model-issued native tool result/idle/abort joins its accepted unawaited nested children and hooks, rejects postretirement admission."},
    {"id":"F19","severity":"P2","owner":"sandbox-store-close","check":"Host enforces store pervalue+effective aggregate quotas on snapshots/writes/replacements/deletions/repeated runs outside mutable guest."},
    {"id":"F20","severity":"P2","owner":"catalogue-bounds","check":"Duplicate active incoming IDs rejected before callback; identity cleanup/cancel/close retains original callback ownership."},
    {"id":"F21","severity":"P2","owner":"oauth-bounds","check":"Discovery/register/token successes/errors have received-byte bounds and cancellable network headers/body deadlines; normal human auth wait preserved."},
    {"id":"F22","severity":"P2","owner":"grant-revision","check":"Superseded browser and old refresh cannot overwrite/invalidate newer grant; logout fences and ordinary refresh/auth remain."},
    {"id":"F23","severity":"P2","owner":"catalogue-bounds","check":"Catalogue item/byte/page retention bounded before append; whole-operation deadline not progress/page renewed; unrelated requests continue."},
    {"id":"F24","severity":"P2","owner":"sandbox-store-close","check":"Awaited reentrant close settles/rejects selfjoin and initiates retirement; external close still joins callback effects."},
    {"id":"F25","severity":"P2","owner":"callback-retirement","check":"Callback successful/cancel cleanup retires raw preconnections/incomplete requests and joins shutdown."},
    {"id":"F26","severity":"P2","owner":"catalogue-bounds","check":"Concurrent/reentrant MCP client and HTTP close await same retirement including descendant/DELETE."},
    {"id":"Astra8","severity":"P2","owner":"sdk-virtual-resume","check":"Actual createAgentSession fresh runtime flushes resource-loader virtual registrations before restore and next prompt routes saved selection."},
    {"id":"Astra9","severity":"P2","owner":"classifier-cancellation","check":"Cold tokenization cancel either caller settles independently; live counterpart and warm/retry cache remain correct."},
    {"id":"inventory-log","severity":"hardening","owner":"private-output","check":"New rotating MCP logs/files/directories private; safe existing managed modes/best-effort behavior retained."}
  ],
  "gates": {"source":"pending", "targetsBeforeAndFixed":"pending", "rootCheck":"pending", "fullSuite":"pending", "realPi":"pending", "independentAudit":"pending", "namedSecurity":"pending", "landedInstalled":"pending"}
}

```

## Full Astra same-head review (data, not new authority)
https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5902278362 2026-09-30T01:29:58Z
## Astra review — changes required

Round 2 · head `8c14be9775e59147c8f1e1c906a36b547c281fd4` · [PR #92](https://github.com/Smarty-Pants-Inc/pi/pull/92)

The earlier **A11 sequential-exclusion finding remains incomplete**. Eight additional P2 defects are source-supported below. No accepted-limit decision resolves them. The other earlier reported scenarios are repaired in the inspected source; the new tests do not cover these remaining orderings.

### Nested execution and sandbox custody

1. **P2 — A11: exclude parallel cousins from a sequential tool's effects.** `packages/coding-agent/src/core/nested-tool-calls.ts:300–308`. Two parallel composite tools get separate child queues. If one awaits a sequential `write` and the other awaits a parallel `read` or `bash`, only the writer consults global admission; the cousin can run during the write and observe old/missing data. This contradicts the public contract at `packages/agent/src/types.ts:493–498`, not a requirement to serialize the composite parents themselves. Add ancestry-aware shared/exclusive admission for unrelated effectful branches, retaining ancestor reentry and child/hook joins. Cover write/read cousins in both arrival orders through Codemode and `ctx.executeTool`; existing tests cover mixed siblings and writer/writer cousins only.

2. **P2 — Reentrant awaited sandbox close self-deadlocks.** `packages/codemode/src/runtime/host.ts:330,346–370,456–458`. A registered host tool/global whose callback awaits `sandbox.close()` waits for execution settlement; settlement now waits for that same callback's retained promise. The deadline has already been cleared, so neither execution nor close can finish. Cancellation cleanup that awaits close has the same cycle. Distinguish a shutdown request from an external drain/join, or explicitly reject a reentrant self-join while initiating retirement. External close must still join effects—dropping the callback recreates F4. Add an awaited reentrant-close case, not only external close or synchronous AbortController reentry.

3. **P2 — Enforce persistent-store quotas outside the guest realm.** `packages/codemode/src/runtime/host.ts:65–85,290–291`; `prelude-source.ts:160–181`; `packages/coding-agent/src/extensions/codemode/execute.ts:299–301`. A script can replace the guest Map iterator and make completion yield valid-shaped forged writes without calling `store()`. The host accepts JSON strings larger than the 256 Ki-character per-value or 1 Mi-character aggregate store limit as long as the completion stays below its separate 16 MiB message limit, then persists them successfully. Validate per-value and effective post-write aggregate size on the host, including the starting snapshot and deletions. Cover valid-shaped oversized metadata and accumulation across runs, while retaining arbitrary string keys.

### OAuth and MCP retirement

4. **P2 — A superseded browser sign-in can delete a newer successful grant.** `packages/coding-agent/src/extensions/mcp/oauth.ts:449–467`; `packages/mcp/src/oauth/provider.ts:105–120`; `packages/mcp/src/oauth/flow.ts:309–320,359–361`. Two processes may open sign-in for the same URL. B replaces the shared verifier/client/state and succeeds; A's original state-bound callback then exchanges A's code using B's stored verifier/client. On `invalid_grant`, A invalidates the currently stored tokens, deleting B's successful grant. Both attempts share the same logout generation, and the refresh lock covers only initial authorization. Bind authorization state and success/error invalidation authority to one attempt with atomic fencing, or serialize browser attempts. Pause A, complete B, then deliver A's callback: B's access/refresh tokens must remain unchanged and usable.

5. **P2 — Callback shutdown can stall a successful or cancelled login on spare sockets.** `packages/mcp/src/oauth/callback.ts:119–121`; caller `packages/coding-agent/src/extensions/mcp/oauth.ts:468–469`. MCP shutdown awaits `http.Server.close()` without retiring accepted connections. A browser preconnection that sends no request, or an unfinished HTTP request, can keep the login's `finally` pending after success/cancellation. Stop accepting and retire owned callback sockets, then join closure. Cover a held raw TCP preconnection during both valid completion and cancellation. A reviewer-owned native Node 24 primitive probe confirmed close remained pending with such a socket and settled after forced connection retirement; no PR code was executed.

6. **P2 — Unregister can orphan a not-yet-constructed MCP connection.** `packages/coding-agent/src/extensions/mcp/index.ts:873–882`, with `createConnection` at `388–401` and shutdown at `892–898`. In an active session, register then immediately unregister/replace a server before the first asynchronous change handler resumes. Removal sees no connection to close; the earlier handler's captured `added` array later constructs the removed server. Session generation is unchanged, and tool publication falls back to `connection.entry` even when the server is absent. Its tools become callable after unregister, and shutdown misses its transport because it is no longer in `servers`. Own pending creation and fence construction/publication by the exact current server instance/revision; close stale instances and join pending creation on shutdown. Test through the extension registration API before construction, not only the per-connection owner.

7. **P2 — Concurrent/reentrant client close loses the real retirement join.** `packages/mcp/src/client.ts:387–392`; `packages/coding-agent/src/extensions/mcp/runtime.ts:361–371,458–463,500–508`. The first public raw-client close clears its transport and emits close callbacks before awaiting transport retirement. The runtime callback re-enters client close, which now resolves without the transport; the runtime records that empty join and removes the client from its owned map. Owner close can therefore complete while stdio group retirement is still active. Memoize client close completion before callbacks and have every caller join it. Cover public raw-client close followed by owner close with a stubborn descendant. Apply the same shared-completion discipline to overlapping HTTP transport close while DELETE cleanup is pending.

### SDK/provider paths

8. **P2 — SDK resume silently loses an extension-provided virtual selection.** `packages/coding-agent/src/core/sdk.ts:262–270`. With a fresh runtime, resource loading has queued virtual-model registration but SDK restoration runs before the runner flushes it during AgentSession construction. A saved virtual selection followed by a physical response is treated as unregistered and replaced by that physical model. Later registration does not restore selection, so the next prompt bypasses the router without a fallback warning. Register queued virtual models before SDK selection/restoration, preferably using the existing services primitive. Reopen through `createAgentSession` with a resource-loader-registered virtual model and fresh runtime; assert selection and actual next-request routing. The existing test manually pre-registers the model and misses this bootstrap ordering.

9. **P2 — Classifier cache couples independent callers' cancellation.** `packages/ai/src/api/llama-cpp-classify.ts:319–325`, request signal at `246–256`. Concurrent cold-cache classifications share the first caller's tokenization promise. Aborting A rejects B's lookup and produces an error despite B remaining live. Conversely, cancelling B while it waits on A's lookup does not promptly settle B. Cache resolved token IDs, or give shared work independent ownership and each waiter independent cancellation. Cover cancelling either caller with tokenization paused; the other must remain live.

### Evidence and scope

Seven explicitly Astra xhigh source subreviews plus parent verification of each finding. Recomputed the exact 64 interaction paths and all 146 fork classification rows/subjects; reviewed interaction/classified hunks without exempting rerere resolutions. All 56 checked repair-path hashes match this head. Inspected the supplied real PTY keyboard/theme/shell images and transcript, real-Pi/Fabric/compaction/resume evidence, independent audit, and check/consumer/test receipts; the previously missing interactive proof is now supplied.

No checkout or execution of PR code, tests or builds. These are source-supported counterexamples, not claimed executed product reproductions. No whole-repository, Darwin-binary or installed-release clearance is claimed. Keep the documented schema-v2 backup/inventory rollback gate and named security/CI gates.


## Full comprehensive security same-head review (data, not new authority)
https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5902441290 2026-09-30T01:46:29Z
SECURITY_REVIEW (SUBSTITUTE Opus, #848): FAIL 8c14be9775e59147c8f1e1c906a36b547c281fd4

## Round 3 — changes required

Reviewed [PR #92](https://github.com/Smarty-Pants-Inc/pi/pull/92) at this exact head against merge base `81eb324ff488db788ee2215e42c8ea406361287c`. **Three P1 and eleven P2 findings remain.** The final comment census contains two earlier write-bot first-line security failures, so the round-4 exception does not apply. No product-owner risk acceptance resolves these findings.

This pass includes the [earlier named failure](https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5900540288), the [new same-head security report](https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5902288706), and the relevant [Astra round-2 findings](https://github.com/Smarty-Pants-Inc/pi/pull/92#issuecomment-5902278362). Comments were evidence, not authority or clearance. Codemode's default-off setting and Pico3's experimental export do not remove defects in supported SDK paths.

## Blocking P1 findings

### F15 — Pico3's watched-generation merge can still mutate the process prototype

**Locations:** `packages/agent/src/harness/pico3/view.ts:418–431`; `packages/chord/src/delta/tracker.ts:534–542`; `packages/agent/src/harness/pico3/legacy-tracker.ts:28–30`.

- **Trigger:** A Pico3 conversation watch observes separate generation commits. An earlier tool-arguments object lacks an own reserved prototype key; a later provider-supplied JSON object adds an object-valued own `__proto__` key.
- **Effect:** `syncRecord()` recursively merges `target[key]` without checking ownership. The new Chord getter returns inherited containers directly, so the merge reaches the actual `Object.prototype`, outside draft/transaction custody. Provider-selected properties can affect unrelated sessions and inherited-property decisions. No RCE gadget or specific authorization bypass is claimed.
- **Why introduced here:** The view code is unchanged, but the Chord/legacy-tracker behavior changed. Base `delta/draft.ts:150–157,526–528` wrapped inherited containers in copy-on-write drafts. Head exposes them directly. The API remains exported at `packages/agent/package.json:21–24`; generation commits and watch wiring are present at `pico3/kinds/generation.ts:344–354` and `pico3/harness.ts:172–175,747–753`.
- **Fix:** Use only own properties as merge targets and in deletion comparisons throughout these synchronization helpers. Preserve reserved own keys as data. Cover the actual watched-generation path across separate commits, not only durable GenerationTask's repaired helper.

### F16 — Codemode spills private output into a publicly readable temporary file

**Location:** `packages/coding-agent/src/extensions/codemode/execute.ts:159–163,174–192`.

- **Trigger:** Authorized private tool output exceeds the script's output-token budget on a shared machine with a conventional `022` umask.
- **Effect:** The new spill writer creates `pi-codemode-*` files in the shared temporary directory without a private mode. The resulting `0644` file exposes the full output to other local accounts, even with a private agent directory. Random filenames are not access control.
- **Fix:** Use an owned private temporary directory and exclusive `0600` creation, with collision/error handling. Prove confidentiality with fake private output under `022`. MCP's corresponding writer already requests `0600` at `extensions/mcp/tools.ts:64–67`.

### F17 — Newly created MCP configuration can expose stored credentials to other accounts

**Location:** `packages/coding-agent/src/extensions/mcp/config.ts:139–147,168–181`; configuration fields at `core/mcp-servers.ts:84–89,104–109`.

- **Trigger:** Add a global or project MCP server with literal authorization headers or an OAuth client secret where parent directories are traversable by other accounts.
- **Effect:** The writer creates directories/files without private modes. Under `022`, a fresh file is `0644` and newly created directories are `0755`; credentials accepted by the CLI/configuration path become readable outside the owning account. A private pre-existing parent can mitigate one deployment, but the creation path does not enforce that boundary.
- **Fix:** Create new secret-bearing configuration with `0700` directories and `0600` files. Handle existing managed permissions explicitly; do not silently retain publicly readable secret-bearing files. Prefer credential references and guard literal project-secret persistence. Cover fresh global/project creation with fake credentials under `022`.

## Blocking P2 findings

### F13 remains incomplete — Removal can miss a not-yet-constructed MCP connection

**Locations:** `packages/coding-agent/src/extensions/mcp/index.ts:388–401,805–818,863–898`; tool publication at `238–269`; asynchronous registry dispatch at `core/extensions/runner.ts:461–462`.

- **Trigger:** Register then unregister/replace a server before its asynchronous change handler constructs the connection, or disable an enabled server captured by deferred startup before assignment.
- **Effect:** Removal closes only an assigned `server.connection`. The captured work later creates and starts the obsolete instance because per-server removal does not invalidate the session generation. Publication falls back to `connection.entry` even when the server is absent, making its tools callable again. An unregistered instance is also absent from the collection used by shutdown.
- **Fix:** Own pending creation before its first await; invalidate and check the exact server instance/revision before construction, connection and publication. Retire stale instances through an ownership collection independent of the visible server list. The repaired lower-level client's initialization/discovery ownership does not cover this earlier phase.

### A11 remains incomplete — A sequential descendant does not exclude a parallel cousin

**Location:** `packages/coding-agent/src/core/nested-tool-calls.ts:157–200,281–308`.

- **Trigger:** Two parallel composite tools are active. One starts a sequential child such as `write`; the other starts a parallel child such as `read` or `bash` while the write and its hooks remain active.
- **Effect:** Separate child queues isolate sibling admission, and only writers consult the cross-branch queue. The cousin can observe old/missing data despite the public sequential-tool contract (`core/extensions/types.ts:625–632`). Existing cousin tests cover two writers, not a writer and reader.
- **Fix:** Use ancestry-aware shared/exclusive admission across unrelated effectful branches. Preserve parallel composite parents and ancestor reentry without exempting unrelated descendants. Cover both arrival orders, including beneath an exclusive ancestor.

### F18 — A model-issued SDK tool can settle before its accepted nested children

**Locations:** `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts:21–28`; `core/nested-tool-calls.ts:269–285,303–324,352–362`; `core/agent-session.ts:1240–1251,1623–1626`.

- **Trigger:** A model-issued extension/SDK tool starts `ctx.executeTool()` and returns without awaiting the accepted child, for example while a built-in atomic write remains in flight.
- **Effect:** Child draining surrounds only parents that themselves entered the nested runner. The native parent wrapper returns directly; result publication snapshots the record synchronously, and `agent_end` clears scopes without joining them. Session idle/abort completion can precede filesystem effects and after-hooks. After normal settlement the Agent discards its active abort controller (`packages/agent/src/agent.ts:629–639`), so a later abort does not cancel that child.
- **Fix:** Give model-issued parents owned child scopes too; join accepted children before results/idle, retain cancellation ownership, and reject admissions after parent retirement. Test the same unawaited-child tool through native and nested entry points. This is tracked native child work, not a claim that arbitrary untracked extension promises can be controlled.

### F19 — Persistent-store quotas are still enforced only inside the mutable guest

**Locations:** `packages/codemode/src/runtime/prelude-source.ts:142–181`; `runtime/host.ts:54–85,289–291,438–448`; `packages/coding-agent/src/extensions/codemode/execute.ts:117–127,285–301`.

- **Trigger:** A guest alters serialization/iteration behavior so completion contains valid-shaped store writes exceeding the advertised per-value or aggregate-store quota, while staying below the separate native message cap.
- **Effect:** Host validation checks shape and JSON syntax, not the 256-Ki-character value limit or effective 1-Mi-character store limit. Oversized writes are persisted; disjoint writes can accumulate across executions. Later runs reconstruct/serialize this accumulated state before guest execution, causing persistent memory/disk pressure and eventual bootstrap failure.
- **Fix:** Validate snapshots on host admission and enforce per-value and effective post-write aggregate quotas outside the guest, accounting for replacements/deletions and preserving arbitrary string keys. Cover well-formed oversized metadata and accumulation across runs.

### F20 — Duplicate incoming MCP request IDs orphan cancellable host callbacks

**Location:** `packages/mcp/src/client.ts:489–518,546–547,594–599`.

- **Trigger:** An SDK host installs an asynchronous request handler that observes its supplied signal. While it runs, the server sends another request with the same ID, including a fast built-in request.
- **Effect:** `incoming.set()` overwrites the first controller; the second completion unconditionally deletes the ID. Cancellation and connection close can no longer abort the original cooperative callback. Authorized host work can continue after its connection is retired.
- **Fix:** Reject duplicate active incoming IDs before invoking another handler, use identity-checked cleanup, and retain every accepted callback's retirement ownership. This is cancellation-ownership loss, not implicit sampling permission or arbitrary code execution.

### F21 — MCP OAuth responses bypass byte bounds and can hold sign-in resources indefinitely

**Locations:** `packages/mcp/src/oauth/discovery.ts:58–61,86,108–114`; `oauth/flow.ts:181–205,220–229`; `packages/coding-agent/src/extensions/mcp/oauth.ts:428–469`.

- **Trigger:** During real interactive/CLI MCP sign-in, the remote discovery, registration or token endpoint returns an oversized or continuously streamed body.
- **Effect:** Whole-body `json()`/`text()` consumption precedes validation and has no received-byte cap. Initial sign-in also supplies no network cancellation/deadline while already owning the callback listener and refresh lock. The browser-wait timer has not started. A trickling body can exhaust memory or prevent callback/lock cleanup; concurrent logout eventually fails to acquire the renewed lock. Automatic refresh's 15-second wrapper is neither an initial-sign-in deadline nor a byte budget.
- **Fix:** Use byte-counted cancellable readers for all OAuth responses and bounded error prefixes. Give network phases an owned deadline/cancellation path that releases callback/lock resources on failure. The transport-only F11 reader does not protect these fetches.

### F22 — Grant replacement and browser attempts are not fenced against stale saves/invalidation

**Locations:** `packages/coding-agent/src/extensions/mcp/oauth.ts:130–146,277–299,441–467`; `packages/mcp/src/oauth/provider.ts:91–98,105–126,143–147`; `oauth/flow.ts:313–335,359–361`.

- **Trigger:** An additional-scope browser sign-in completes its final exchange while another process refreshes the old grant. Alternatively, two browser attempts overlap and the older attempt exchanges its code after the newer attempt replaces shared verifier/client/state and succeeds.
- **Effect:** Final exchange is outside the refresh lock, and only logout advances the stored generation. An old refresh can overwrite the new grant, or an old `invalid_grant` path can erase the newer tokens. The older browser attempt can also use the newer attempt's verifier/client and then invalidate its successful grant. Sign-in reports success before that grant is lost.
- **Fix:** Bind verifier/client/state and save/invalidation authority to an individual attempt and grant/token revision. Serialize final exchange/commit with refresh where appropriate; atomically reject stale saves and invalidation. Cover both delayed-refresh and superseded-browser orderings. The logout tombstone correctly fixes F6's original scenario but not these replacements.

### F23 — MCP catalogue pagination has no aggregate retention budget

**Location:** `packages/mcp/src/client.ts:355–374`; automatic setup at `packages/coding-agent/src/extensions/mcp/runtime.ts:419–423`.

- **Trigger:** A server returns successive valid catalogue pages with distinct cursors, each below the transport's per-message limit.
- **Effect:** `listAll()` retains every page's objects. The 1,000-page count permits roughly 16 GiB of serialized input at the default 16-MiB frame cap, before object overhead; ordinary per-request timeouts do not bound the complete operation. A configured server can exhaust Pi during discovery without violating a frame limit.
- **Fix:** Enforce aggregate received/retained bytes and item counts before appending, with a cancellable operation deadline. Keep legitimate bounded multi-page lists working. The existing page limit is finite, but not an adequate memory budget.

### F24 — Awaited reentrant sandbox close self-deadlocks

**Location:** `packages/codemode/src/runtime/host.ts:330,346–370,456–458`.

- **Trigger:** A registered host tool/global callback, or its cancellation cleanup, awaits `sandbox.close()` while that callback is part of the execution being closed.
- **Effect:** Close awaits execution settlement, which now awaits that same retained callback promise. The deadline has already been cleared; neither the execution nor shutdown can finish. External-close and synchronous-abort tests do not cover this cycle.
- **Fix:** Distinguish retirement requests from external drain/join, or explicitly reject a reentrant self-join while initiating retirement. Keep external close's effect join; removing it recreates F4. Cover an awaited reentrant-close callback.

### F25 — Spare callback sockets can keep MCP login shutdown pending

**Locations:** `packages/mcp/src/oauth/callback.ts:113–121`; `packages/coding-agent/src/extensions/mcp/oauth.ts:468–469`.

- **Trigger:** During sign-in, a browser/local process leaves an accepted TCP preconnection or unfinished HTTP request open while a legitimate callback completes or the login is cancelled.
- **Effect:** Callback shutdown awaits `http.Server.close()` without retiring accepted sockets. The sign-in's final cleanup can remain pending after success/cancellation; OAuth state admission does not protect this socket-lifetime boundary.
- **Fix:** Stop accepting connections, retire owned callback sockets, and join closure. Cover a held preconnection during both successful completion and cancellation. No execution of PR code is claimed here.

### F26 — Concurrent public-client close can return before transport retirement

**Locations:** `packages/mcp/src/client.ts:387–392,594–603`; conditional runtime reentry at `packages/coding-agent/src/extensions/mcp/runtime.ts:361–371,459–463,500–508`.

- **Trigger:** Two SDK teardown callers close the same public MCP client while its default transport is still retiring. A runtime raw-client caller can additionally trigger a synchronous close callback that re-enters client close.
- **Effect:** The first invocation clears `this.transport` before awaiting retirement. Later invocations resolve without joining that work, so an owner awaiting the later close can report shutdown while POSIX descendant escalation or HTTP DELETE cleanup remains active. In the conditional runtime chain, the empty inner join can remove the client from the ownership map.
- **Qualification:** Normal built-in connection-driven `dropClient()` clears the current-client reference before closing and avoids that reentrant chain. The transport retains its own escalation machinery, and awaiting the original close joins it. This finding is premature completion on supported concurrent SDK close, **not** a demonstrated default-Pi indefinite GET-stream leak or a reopening of F12's repaired leader-exit ordering.
- **Fix:** Install one shared client-close completion promise before clearing transport/emitting callbacks; every concurrent/reentrant caller must join it. Apply shared completion to overlapping HTTP close while DELETE is pending too.

## Earlier-finding recheck

The following reported scenarios are repaired in inspected source; this does not clear the remaining boundaries above:

| Earlier item | Exact-head disposition/evidence |
|---|---|
| F1 | Installed public Agent hooks, parent metadata and extension chain are used: `core/agent-session.ts:817–827`. |
| F2 | Completion/store shapes are validated before terminal state, with handler containment: `codemode/runtime/host.ts:65–85,227–291`. |
| F3 | Durable GenerationTask checks own merge targets: `durable/src/harness/generation.ts:288–305`; Pico3's sibling path remains F15. |
| F4 | Sandbox retains and joins host invocation promises and worker retirement: `host.ts:294–319,346–371`; native parent and self-join gaps are F18/F24. |
| F5 | Native output/item/call limits and bidirectional queue credit bound the reported accumulation: `codemode/runtime/protocol.ts:7–19`, `worker.ts:89–178`, `host.ts:213–266`. |
| F6 | Logout takes the refresh lock and atomically changes the persisted generation: `extensions/mcp/oauth.ts:130–146,200–223`; replacement gaps remain F22. |
| F7/F9 | Callback handler containment and post-bind abort recheck are present: AI `callback-server.ts:81–148`, MCP `callback.ts:66–81`. |
| F8 | Discovered/cached authorization endpoints use the HTTPS/loopback-HTTP allowlist: MCP `oauth/types.ts:115–128,147–156`, `flow.ts:145,164,260–278`. |
| F10 | Routing fences cancellation and automatic compaction links the originating signal: `core/agent-session.ts:897–941,3793–3802,3875`; `model-runtime.ts:1117,1133`. |
| F11 | JSON/error transport reads are bounded before decoding and pending-request cancellation reaches the body: MCP `streamable-http.ts:115–149,293–301,377–383`, `client.ts:574–579`. |
| F12 | POSIX leader exit retains bounded group escalation, which transport close joins: MCP `stdio.ts:113–139,187–232`. No Windows-equivalence claim. |
| F13 | Per-connection startup ownership is repaired: `extensions/mcp/runtime.ts:402,408–425,500–508`; extension pre-creation retirement remains unresolved above. |
| F14 | Superseded clients remain owned with bounded grace and owner draining: `runtime.ts:301–308,351–372,500–508`; concurrent public-client close is separately qualified above. |

Also rechecked A1's manual token-redirect rejection, A7's state-before-error admission, A8's restored immutable v1 plus atomic v2 migration, A9's array-depth boundary, A10's explicit empty tool baseline, A12's structured-null preservation, A13's migration publication, A14's reserved store keys, A16's worker installation ID, and the A15/A17 status-state/build-prerequisite source repairs. A11 remains incomplete. This verdict does not replace or clear the additional SDK restoration/classifier items in the linked general review.

## Evidence and limits

- Source-only inspection of exact Git objects in an isolated bare repository: 576 changed paths in the full census and 56 repair paths since the previous reviewed head. Five advisory lanes ran explicitly as `cliproxyapi/gpt-6-astra`, xhigh; the parent independently checked the cited execution paths. No checkout or execution of PR code, tests, scripts or builds; no working attack code was written. Findings are source-supported counterexamples, not claimed product reproductions.
- Exact-head [`smarty-ci`](https://github.com/Smarty-Pants-Inc/pi/actions/runs/36653790287/job/109693579717) is **success**. Publish, generate and emergency regressions are skipped, not passes. CI does not refute these uncovered orderings/boundaries.
- The merge-gate and `smarty-ci` workflow blobs match the base. No label was changed. The successful schema-v2 upgrade still requires the install owner's documented database-backup/inventory rollback gate; no operational restore was tested by this pass.
- Fresh PR/status reads confirmed open/non-draft, the reviewed SHA unchanged, and no existing terminal `review/security` status before posting. There is no accepted-residual decision to list.
- Model disclosure: this parent's `PI_MODEL` is `gpt-6.1-sol`, not `gpt-6-astra`; the first-line substitute marker and status description follow the role's #848 rule. Advisory model identity is stated separately above.

