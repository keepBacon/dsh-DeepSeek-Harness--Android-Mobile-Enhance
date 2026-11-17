#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {projectBuildCall,projectBuildTools} from './dsh-project-build.mjs'
const home=await mkdtemp(join(tmpdir(),'dsh-p2-build-'))
try{
 const project=join(home,'py')
 await mkdir(project)
 await writeFile(join(project,'pyproject.toml'),'[build-system]\nrequires = []\n')
 await writeFile(join(project,'test_example.py'),
  'import unittest\nclass Tests(unittest.TestCase):\n def test_ok(self):\n  self.assertEqual(2+2,4)\n')
 assert.equal(projectBuildTools.length,4)
 const detected=await projectBuildCall('workspace_detect',{root:project})
 assert.equal(detected.selected,'python')
 assert.equal(detected.ambiguous,false)
 const dry=await projectBuildCall('workspace_verify',{root:project,dryRun:true})
 assert.equal(dry.ok,true)
 assert.equal(dry.steps.length,2)
 const actual=await projectBuildCall('workspace_verify',{root:project,timeoutMs:30000})
 assert.equal(actual.ok,true,JSON.stringify(actual.steps))
 assert.equal(actual.steps.length,2)
 assert.match(actual.steps[1].stderr,/Ran 1 test/)
 const broken=join(home,'broken')
 await mkdir(broken)
 await writeFile(join(broken,'pyproject.toml'),'[build-system]\n')
 await writeFile(join(broken,'broken.py'),'def broken(:\n')
 const failure=await projectBuildCall('workspace_verify',{root:broken,timeoutMs:10000})
 assert.equal(failure.ok,false)
 assert.equal(failure.failedPhase,'build')
 assert.ok(failure.steps[0].stderr.includes('SyntaxError')||failure.steps[0].stdout.includes('SyntaxError'))
 const npm=join(home,'npm')
 await mkdir(npm)
 await writeFile(join(npm,'package.json'),JSON.stringify({scripts:{build:'node -e "process.exit(0)"'}}))
 const missing=await projectBuildCall('workspace_test',{root:npm})
 assert.equal(missing.ok,false)
 assert.match(missing.nextAction,/lacks a test script/)
 const cmake=join(home,'cmake')
 await mkdir(cmake)
 await writeFile(join(cmake,'CMakeLists.txt'),'cmake_minimum_required(VERSION 3.15)\nproject(test C)\n')
 const preview=await projectBuildCall('workspace_build',{root:cmake,dryRun:true})
 assert.equal(preview.prerequisites.length,1)
 assert.deepEqual(preview.prerequisites[0].args.slice(0,2),['-S',cmake])
 await assert.rejects(projectBuildCall('workspace_detect',{root:join(home,'missing')}),/ENOENT/)
 console.log('[DSH] P2 project detection, Python build/test, diagnostics, npm manifest and CMake plan: OK')
}finally{await rm(home,{recursive:true,force:true})}
