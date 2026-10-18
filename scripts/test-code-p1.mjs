import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {codeAstEdit,codeRefactor,codeContractCheck,codePatchConflict,codeFailureCluster,codeCheckpoint} from './dsh-code-p1.mjs'
import {agentTaskDecompose,agentScopeAllocate,agentSharedContext,agentFailureRecovery,agentResultReview,agentMergeGuard} from './dsh-agent-p1.mjs'
const check=(value,label)=>{if(!value)throw Error(label)}
const d=await mkdtemp(join(tmpdir(),'dsh-p1-'))
const old=process.env.DSH_CODE_TX_HOME,oldIndex=process.env.DSH_CODE_INDEX_HOME,oldCp=process.env.DSH_CODE_CHECKPOINT_HOME,oldHome=process.env.HOME
process.env.DSH_CODE_TX_HOME=join(d,'tx');process.env.DSH_CODE_INDEX_HOME=join(d,'index');process.env.DSH_CODE_CHECKPOINT_HOME=join(d,'checkpoints');process.env.HOME=d
try{
 const root=join(d,'project');await mkdir(root)
 const text='def alpha():\n    return 1\n'
 await writeFile(join(root,'mod.py'),text)
 const sha=createHash('sha256').update(text).digest('hex')
 const edit={root,path:'mod.py',symbol:'alpha',expectedSha256:sha,newText:'def alpha():\n    return 2\n'}
 const preview=await codeAstEdit(edit)
 check(preview.dryRun&&await readFile(join(root,'mod.py'),'utf8')===text,'ast dry run')
 const applied=await codeAstEdit({...edit,dryRun:false})
 check(applied.state==='committed'&&(await readFile(join(root,'mod.py'),'utf8')).includes('return 2'),'ast apply')
 let stale=false;try{await codeAstEdit({...edit,dryRun:false})}catch{stale=true}check(stale,'sha guard')
 const rename=await codeRefactor({root,oldName:'alpha',newName:'beta',paths:['mod.py']})
 check(rename.dryRun&&rename.requiresSemanticReview,'unsafe refactor')
 const contracts=await codeContractCheck({root});check(contracts.readOnly,'contract')
 const conflicts=await codePatchConflict({root,changes:[{path:'mod.py',expectedSha256:sha}]})
 check(!conflicts.safeToApply,'conflict')
 const cluster=codeFailureCluster({log:'main.cpp:1:2: error: missing x\nmain.cpp:2:4: error: missing y'})
 check(cluster.groups.length>0,'diagnostic cluster')
 const cp=await codeCheckpoint({root,paths:['mod.py'],action:'save'})
 check(cp.saved,'checkpoint save')
 const replay=await codeCheckpoint({root,paths:['mod.py'],action:'check',id:cp.id})
 check(replay.match,'checkpoint validation')
 const board=await agentTaskDecompose({tasks:[{id:'work',title:'Implement',writeScopes:['mod.py']}]})
 const a={boardId:board.boardId,taskId:'work'}
 const scope=await agentScopeAllocate(a);check(scope.writeScopes.includes('mod.py'),'scope')
 const shared=await agentSharedContext({boardId:board.boardId});check(shared.tasks.length===1,'shared')
 const review=await agentResultReview({...a,root,paths:['mod.py']});check(review.approved===false,'review')
 await symlink('mod.py',join(root,'linked.py'))
 let symlinkRejected=false
 try{await agentResultReview({...a,root,paths:['linked.py']})}catch(e){
  symlinkRejected=/SYMLINK_IN_REVIEW_PATH/.test(String(e.message))
 }
 // Symlink defense is evaluated even when the task allows unrestricted scope.
 const unrestricted=await agentTaskDecompose({tasks:[{id:'read',title:'Review unrestricted'}]})
 try{await agentResultReview({boardId:unrestricted.boardId,taskId:'read',root,paths:['linked.py']})}
 catch(e){symlinkRejected=/SYMLINK_IN_REVIEW_PATH/.test(String(e.message))}
 check(symlinkRejected,'symlink review allowed')
 const guard=await agentMergeGuard({...a,root,paths:['mod.py']});check(!guard.eligibleForManualMerge,'merge guard')
 const recovery=await agentFailureRecovery({boardId:board.boardId});check(recovery.pending.includes('work'),'recovery')
 console.log('[DSH] P1 coding & coordination integration: OK')
}finally{
 for(const [k,v] of [['DSH_CODE_TX_HOME',old],['DSH_CODE_INDEX_HOME',oldIndex],['DSH_CODE_CHECKPOINT_HOME',oldCp],['HOME',oldHome]]){if(v===undefined)delete process.env[k];else process.env[k]=v}
 await rm(d,{recursive:true,force:true})
}
