package com.dshmobile.shell
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.widget.*
import org.json.JSONObject

/** Host-only native database manager. No arbitrary SQL crosses the WebView bridge. */
internal class DshDatabaseUi(private val activity: Activity, private val pickFile: (String) -> Unit = {}) {
  private val db by lazy { DshDatabaseStore(activity) }
  private val files by lazy { DshDatabaseAttachments(activity) }
  private val prefs by lazy { activity.getSharedPreferences("dsh-native-database",Context.MODE_PRIVATE) }
  private fun enabled()=prefs.getBoolean("enabled",true)
  private fun auth(scope:String)=DshDatabaseStore.WriteAuthorization.fromConfirmedUserAction(scope)
  private fun error(e:Throwable){ AlertDialog.Builder(activity).setTitle("操作失败").setMessage(e.message).setPositiveButton("确定",null).show() }
  private fun safe(block:()->Unit){try{block()}catch(e:Throwable){error(e)}}
  private fun column()=LinearLayout(activity).apply{
    orientation=LinearLayout.VERTICAL
    val p=(16*resources.displayMetrics.density).toInt()
    setPadding(p,p,p,p)
  }
  private fun field(hintText:String,value:String="",multiline:Boolean=false)=EditText(activity).apply{
    hint=hintText;setText(value)
    inputType=InputType.TYPE_CLASS_TEXT or (if(multiline) InputType.TYPE_TEXT_FLAG_MULTI_LINE else 0)
    if(multiline)minLines=3
  }
  private fun item(root:LinearLayout,title:String,description:String,action:()->Unit){
    root.addView(TextView(activity).apply{
      text=title+"\n"+description;textSize=16f;setPadding(6,18,6,18)
      setOnClickListener{action()}
    })
  }
  private fun dialog(title:String,root:LinearLayout,action:()->Unit){
    AlertDialog.Builder(activity).setTitle(title).setView(ScrollView(activity).apply{addView(root)})
      .setNegativeButton("取消",null).setPositiveButton("保存"){_,_->safe(action)}.show()
  }
  private fun message(text:String){
    AlertDialog.Builder(activity).setMessage(text).setPositiveButton("确定",null).show()
  }
  fun open()=safe{
    val root=column()
    root.addView(TextView(activity).apply{text="数据库\n模型记忆与安全数据分区";textSize=20f})
    item(root,"数据库","查看分区、数据和访问规则"){
      if(enabled())partitions()else message("数据库已关闭")
    }
    root.addView(TextView(activity).apply{text="设置";textSize=18f})
    root.addView(Switch(activity).apply{
      text="数据库开关";isChecked=enabled()
      setOnCheckedChangeListener{_,value->
        if(!prefs.edit().putBoolean("enabled",value).commit())message("保存失败")
      }
    })
    item(root,"格式化数据库","等待 5 秒并二次确认，永久删除所有数据"){
      if(enabled())confirmFormat()else message("请先开启数据库")
    }
    AlertDialog.Builder(activity).setTitle("数据库").setView(ScrollView(activity).apply{addView(root)})
      .setPositiveButton("完成",null).show()
  }
  private fun partitions()=safe{
    val root=column();val list=db.listPartitions()
    for(i in 0 until list.length()){
      val p=list.getJSONObject(i)
      item(root,p.getString("title")+(if(p.optBoolean("isDefault"))" · 默认" else ""),
        p.optString("description")+"\n"+p.optString("importance")+" · "+p.optString("accessMode")){
        partition(p)
      }
    }
    item(root,"＋ 新建分区","设置名称、权限、重要性、用途说明"){editPartition(null)}
    AlertDialog.Builder(activity).setTitle("分区列表").setView(ScrollView(activity).apply{addView(root)})
      .setPositiveButton("返回",null).show()
  }
  private fun editPartition(old:JSONObject?){
    val root=column()
    val title=field("分区名称",old?.optString("title")?:"")
    val note=field("用途说明",old?.optString("description")?:"",true)
    val priorities=arrayOf("low","normal","high","critical")
    val scopes=arrayOf("global","conversation","workspace")
    val priority=Spinner(activity).apply{adapter=ArrayAdapter(activity,android.R.layout.simple_spinner_dropdown_item,priorities)}
    val scope=Spinner(activity).apply{adapter=ArrayAdapter(activity,android.R.layout.simple_spinner_dropdown_item,scopes)}
    priority.setSelection(priorities.indexOf(old?.optString("importance")?:"normal").coerceAtLeast(0))
    scope.setSelection(scopes.indexOf(old?.optString("accessMode")?:"global").coerceAtLeast(0))
    val accessId=field("指定会话 / 工作区 ID",old?.optString("accessId")?.takeUnless{it=="null"}?:"")
    val read=Switch(activity).apply{
      text="允许模型读取（仅满足访问范围时）";isChecked=old?.optBoolean("allowModelRead")?:false
    }
    root.addView(title);root.addView(note)
    root.addView(TextView(activity).apply{text="重要性"});root.addView(priority)
    root.addView(TextView(activity).apply{text="访问范围"});root.addView(scope)
    root.addView(accessId);root.addView(read)
    dialog(if(old==null)"创建分区" else "编辑分区",root){
      val mode=scope.selectedItem.toString()
      val scopeId=accessId.text.toString().trim().takeIf{mode!="global"}
      if(old==null)db.createPartition(title.text.toString(),note.text.toString(),
        priority.selectedItem.toString(),mode,scopeId,read.isChecked,auth("partition:create"))
      else db.updatePartitionRules(old.getString("id"),title.text.toString(),note.text.toString(),
        priority.selectedItem.toString(),mode,scopeId,read.isChecked,auth("partition:update:"+old.getString("id")))
      partitions()
    }
  }
  fun importSelected(partitionId: String, source: java.io.InputStream, title: String) = safe {
    val imported=files.importFile(source,auth("attachment:import"))
    try {
      db.insertReference(partitionId,"file",title,"已导入的应用私有附件",imported.reference,auth("entry:write:"+partitionId))
      message("附件已保存："+title)
    } catch(e:Throwable) {
      files.pruneUnreferenced(db.allAttachmentReferences())
      throw e
    }
  }

  private fun partition(p:JSONObject, page:Int=0)=safe{
    val id=p.getString("id");val root=column()
    item(root,"分区设置","编辑重要性、说明、读取许可和访问范围"){editPartition(p)}
    item(root,"＋ 添加文本","长期记忆、设计准则"){editText(id,null)}
    item(root,"＋ 导入文件","使用 Android 系统文件选择器，最大 32 MiB") { pickFile(id) }
    item(root,"特殊","凭据须使用 Keystore，不支持明文保存"){
      message("Keystore 凭据代理将在第 3 轮开放")
    }
    val entries=db.listEntries(id,limit=40,offset=page*40)
    for(i in 0 until entries.length()){
      val e=entries.getJSONObject(i)
      val snippet=if(e.optString("kind")=="text")e.optString("text").take(120)else e.optString("description")
      item(root,e.optString("title")+" · "+e.optString("kind"),snippet){entry(id,e)}
    }
    if(page>0)item(root,"← 上一页","第 "+page+" 页"){partition(p,page-1)}
    if(entries.length()==40)item(root,"下一页 →","第 "+(page+2)+" 页"){partition(p,page+1)}
    if(!p.optBoolean("isDefault"))item(root,"删除分区","删除分区及其全部条目"){
      AlertDialog.Builder(activity).setTitle("删除此分区？").setMessage("删除后不能恢复")
        .setNegativeButton("取消",null).setPositiveButton("删除"){_,_->safe{
          db.deletePartition(id,auth("partition:delete:"+id))
          files.pruneUnreferenced(db.allAttachmentReferences());partitions()
        }}.show()
    }
    AlertDialog.Builder(activity).setTitle(p.optString("title"))
      .setView(ScrollView(activity).apply{addView(root)}).setPositiveButton("返回",null).show()
  }
  private fun editText(pid:String,old:JSONObject?){
    val root=column()
    val title=field("标题",old?.optString("title")?:"")
    val body=field("文本内容",old?.optString("text")?:"",true)
    root.addView(title);root.addView(body)
    dialog(if(old==null)"添加文本" else "编辑文本",root){
      db.upsertText(pid,title.text.toString(),body.text.toString(),auth("entry:write:"+pid),old?.optString("id"))
      partitions()
    }
  }
  private fun entry(pid:String,e:JSONObject){
    val root=column()
    item(root,"查看","标题："+e.optString("title")+"\n"+if(e.optString("kind")=="text")e.optString("text")else "特殊引用隐藏"){}
    if(e.optString("kind")=="text")item(root,"编辑","修改标题和内容"){editText(pid,e)}
    item(root,"删除","此操作不可撤销"){
      AlertDialog.Builder(activity).setTitle("删除条目？")
        .setNegativeButton("取消",null).setPositiveButton("删除"){_,_->safe{
          db.deleteEntry(pid,e.getString("id"),auth("entry:delete:"+pid))
          files.pruneUnreferenced(db.allAttachmentReferences());partitions()
        }}.show()
    }
    AlertDialog.Builder(activity).setTitle("数据详情").setView(root)
      .setPositiveButton("返回",null).show()
  }
  private fun confirmFormat(){
    AlertDialog.Builder(activity).setTitle("格式化数据库？")
      .setMessage("将永久删除全部条目、自建分区和私有附件。")
      .setNegativeButton("取消",null).setPositiveButton("继续"){_,_->
        val start=SystemClock.elapsedRealtime()
        val second=AlertDialog.Builder(activity).setTitle("最终确认")
          .setMessage("等待至少 5 秒才能执行不可恢复的格式化。")
          .setNegativeButton("取消",null).setPositiveButton("格式化",null).create()
        second.setOnShowListener{
          val button=second.getButton(AlertDialog.BUTTON_POSITIVE)
          button.isEnabled=false
          val handler=Handler(Looper.getMainLooper())
          val countdown=object:Runnable{
            override fun run(){
              if(!second.isShowing)return
              val remaining=(5000L-(SystemClock.elapsedRealtime()-start)).coerceAtLeast(0L)
              button.text=if(remaining==0L)"格式化" else "格式化 ("+((remaining+999)/1000)+"s)"
              button.isEnabled=remaining==0L
              if(remaining>0)handler.postDelayed(this,150)
            }
          }
          handler.post(countdown)
          button.setOnClickListener{
            if(SystemClock.elapsedRealtime()-start<5000L)return@setOnClickListener
            safe{
              db.formatAll(auth("database:format"))
              files.pruneUnreferenced(emptySet())
              second.dismiss();message("格式化完成。长期记忆分区已重置。")
            }
          }
        }
        second.show()
      }.show()
  }
}
