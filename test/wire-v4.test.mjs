import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareBody } from '../lib/wire.js'

test('V4 developer instructions and tool results preserve order and call identity', async () => {
  const body = await prepareBody({}, {
    model: 'fixture', reasoningEffort: 'off', maxTokens: 1024,
    messages: [
      {role:'system',content:[{type:'text',text:'system'}]},
      {role:'developer',content:[{type:'text',text:'policy'}]},
      {role:'assistant',content:[{type:'reasoning',text:'think'},{type:'tool-call',id:'call-7',name:'read',arguments:'{}'}]},
      {role:'tool',toolCallId:'call-7',content:[{type:'text',text:'result'}]},
    ],
  })
  assert.deepEqual(body.messages.map(m=>m.role),['system','developer','assistant','tool'])
  assert.equal(body.messages[2].tool_calls[0].id,'call-7')
  assert.equal(body.messages[2].reasoning_content,'think')
  assert.deepEqual(body.messages[3],{role:'tool',tool_call_id:'call-7',content:'result'})
  assert.equal(body.reasoning_effort,'none')
})

test('V4 tool images follow their text result without losing the attachment', async () => {
  const ctx={attachments:{readImage:async()=>({ref:{mediaType:'image/png'},data:Buffer.from('image')})}}
  const body=await prepareBody(ctx,{model:'fixture',messages:[{role:'tool',toolCallId:'image-call',content:[{type:'text',text:'image found'},{type:'image',attachment:{id:'fixture'}}]}]})
  assert.equal(body.messages[0].tool_call_id,'image-call')
  assert.equal(body.messages[1].role,'user')
  assert.equal(body.messages[1].content[1].image_url.url,'data:image/png;base64,aW1hZ2U=')
})
