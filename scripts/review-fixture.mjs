export function reviewFixturePlan(team) {
  const owner=role=>team.find(agent=>agent.roles.includes(role)).id;
  return {contractVersion:1,version:'1.0.0',questions:[],decisions:[{id:'D1',description:'Deterministic workflow simulation',source:'user'}],reviewItems:[],
    requirements:[
      {id:'R1',title:'Filter work items',context:'Items have a status',trigger:'Select a status',reaction:'Only matching items remain',acceptanceCriteria:['Unknown or empty status does not change the input list']},
      {id:'R2',title:'Render item names',context:'A selected status exists',trigger:'Render the summary',reaction:'Matching names or an empty message appear',acceptanceCriteria:['A completed item is absent from the open summary']},
    ],design:{screens:[{name:'Board',layout:'Filter above item names',states:['ready','empty']}],palette:['black background','mint active'],spacing:'16px',typography:'system'},
    testPlan:{runner:'node-test',files:['tests/filter.test.cjs'],cases:[
      {id:'T1',requirementId:'R1',title:'Status filter',given:'Open and completed items',when:'Choose open',expected:'Only open item',type:'unit',steps:['Run node --test tests/filter.test.cjs']},
      {id:'T2',requirementId:'R1',title:'Empty input',given:'No items',when:'Choose open',expected:'Empty array',type:'unit',steps:['Run node --test tests/filter.test.cjs']},
      {id:'T3',requirementId:'R2',title:'Rendered filtered names',given:'Two named items',when:'Render open summary',expected:'Open name only',type:'integration',steps:['Run node --test tests/filter.test.cjs']},
      {id:'T4',requirementId:'R2',title:'Empty summary',given:'No matching items',when:'Render summary',expected:'아직 없어요',type:'integration',steps:['Run node --test tests/filter.test.cjs']},
    ]},tasks:[
      {id:'logic',owner:owner('feature'),kind:'feature',title:'Status filtering',requirementIds:['R1'],instructions:'Implement filter.cjs',acceptanceCriteria:['Filter returns matching items'],dependsOn:[],writePaths:['filter.cjs']},
      {id:'screen',owner:owner('ui'),kind:'ui',title:'Summary integration',requirementIds:['R2'],instructions:'Implement view.cjs',acceptanceCriteria:['Summary uses the selected filter'],dependsOn:['logic'],writePaths:['view.cjs']},
      {id:'qa',owner:owner('test'),kind:'test',title:'Actual Node assertions',requirementIds:['R1','R2'],instructions:'Write all four planned tests',acceptanceCriteria:['T1..T4 execute and pass'],dependsOn:['logic','screen']},
    ]};
}
export function reviewFixtureBuild(context, faulty=false) {
  const task=context.task;
  const file=task.kind==='feature'?{path:'filter.cjs',content:faulty?'exports.select=(items,status)=>items;':'exports.select=(items,status)=>status?items.filter(item=>item.status===status):items.slice();'}
    :task.kind==='ui'?{path:'view.cjs',content:"exports.render=(items,status)=>require('./filter.cjs').select(items,status).map(item=>item.name).join(', ')||'아직 없어요';"}
    :{path:'tests/filter.test.cjs',content:`const {test}=require('node:test'),assert=require('node:assert/strict');const {select}=require('../filter.cjs'),{render}=require('../view.cjs');const data=[{name:'Alpha',status:'open'},{name:'Beta',status:'done'}];test('T1 Status filter',()=>assert.deepEqual(select(data,'open'),[data[0]]));test('T2 Empty input',()=>assert.deepEqual(select([],'open'),[]));test('T3 Rendered filtered names',()=>assert.equal(render(data,'open'),'Alpha'));test('T4 Empty summary',()=>assert.equal(render([],'open'),'아직 없어요'));`};
  return {summary:'Included fixture work for '+task.id,files:[file]};
}
