package com.dshmobile.shell

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Host-owned loopback gate. No SQL, scopes, approved flags or raw paths from MCP. */
internal class DshDatabaseBroker private constructor(private val activity: Activity) {
  private val ui=Handler(Looper.getMainLooper())
  private val store=DshDatabaseStore(activity)
  private val server=ServerSocket(0,8,InetAddress.getByName("127.0.0.1"))
  private val alive=AtomicBoolean(true)
  private val secret=ByteArray(32).also { SecureRandom().nextBytes(it) }
  val port:Int get()=server.localPort
  val token:String=Base64.encodeToString(secret,Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  @Volatile private var sessionId:String?=null

  fun setCurrentSession(id:String?) {
    sessionId=id?.takeIf { it.length in 4..180 && it.matches(Regex("[a-zA-Z0-9:_./-]+")) }
  }
  private fun context()=DshDatabaseStore.AccessContext(sessionId,ShellState.lastWorkspacePath(activity),actor="model")
  private fun enabled()=activity.getSharedPreferences("dsh-native-database",Context.MODE_PRIVATE).getBoolean("enabled",true)

  fun start() {
    Thread({
      while(alive.get()) {
        try {
          val client=server.accept()
          Thread({serve(client)},"dsh-database-client").apply{isDaemon=true;start()}
        }catch(_:Throwable){}
      }
    },"dsh-database-broker").apply{isDaemon=true;start()}
  }
  fun stop() {
    alive.set(false)
    try{server.close()}catch(_:Throwable){}
    secret.fill(0)
    store.close()
  }
  private fun serve(socket:Socket) {
    socket.use { client ->
      client.soTimeout=50000
      try {
        val stream=client.getInputStream()
        val raw=ByteArrayOutputStream()
        var boundary=false
        while(raw.size()<4096) {
          val next=stream.read()
          if(next<0)throw IllegalArgumentException("Incomplete headers")
          raw.write(next)
          val b=raw.toByteArray()
          if(b.size>=4 && b[b.size-4]==13.toByte() && b[b.size-3]==10.toByte() &&
            b[b.size-2]==13.toByte() && b[b.size-1]==10.toByte()) {boundary=true;break}
        }
        require(boundary){"Header limit reached"}
        val header=raw.toString("UTF-8")
        val lines=header.split("\r\n")
        require(lines.firstOrNull()=="POST /database HTTP/1.1"){"Invalid method or endpoint"}
        val fields=lines.drop(1).filter{it.contains(':')}.associate{
          it.substringBefore(':').lowercase() to it.substringAfter(':').trim()
        }
        val supplied=fields["x-dsh-token"].orEmpty()
        require(MessageDigest.isEqual(supplied.toByteArray(),token.toByteArray())){"Unauthorized"}
        require(fields["transfer-encoding"]==null){"Chunked requests unsupported"}
        val length=fields["content-length"]?.toIntOrNull() ?: 0
        require(length in 2..16384){"Request exceeds limit"}
        val payload=ByteArray(length)
        var read=0
        while(read<length) {
          val n=stream.read(payload,read,length-read)
          if(n<0)throw IllegalArgumentException("Incomplete body")
          read+=n
        }
        val response=handle(JSONObject(String(payload,Charsets.UTF_8)))
        respond(client,200,response)
      }catch(e:Throwable) {
        respond(client,400,JSONObject().put("ok",false).put("error",(e.message?:"Broker request failed").take(200)))
      }
    }
  }
  private fun respond(client:Socket,status:Int,data:JSONObject){
    val body=data.toString().toByteArray(Charsets.UTF_8)
    val headers="HTTP/1.1 "+status+" "+(if(status==200)"OK" else "Bad Request")+"\r\n"+
      "Content-Type: application/json; charset=utf-8\r\n"+
      "Cache-Control: no-store\r\nConnection: close\r\nContent-Length: "+body.size+"\r\n\r\n"
    try{client.getOutputStream().write(headers.toByteArray(Charsets.UTF_8));client.getOutputStream().write(body);client.getOutputStream().flush()}catch(_:Throwable){}
  }
  // UI visible authorization is independent of any JSON flags sent by the model.
  // Broker deliberately does not return credential values or run network actions.
  private fun scopeSnapshot():DshDatabaseStore.AccessContext = context()

  private fun readableIds():Set<String> {
    val partitions=store.listPartitions(context(),forModel=true)
    return (0 until partitions.length()).map{partitions.getJSONObject(it).getString("id")}.toSet()
  }
  private fun handle(request:JSONObject):JSONObject {
    require(alive.get() && enabled()){"Database disabled"}
    val scope=context()
    return when(request.optString("op")){
      "list" -> JSONObject().put("ok",true).put("partitions",store.listPartitions(scope,forModel=true))
      "search" -> {
        val query=request.optString("query").trim().lowercase()
        require(query.length in 1..120){"Invalid search"}
        val matches=JSONArray()
        val partitions=store.listPartitions(scope,forModel=true)
        for(i in 0 until partitions.length()){
          val partition=partitions.getJSONObject(i)
          val pid=partition.getString("id")
          val metadata=(partition.optString("title")+" "+partition.optString("description")).lowercase()
          val entries=store.listEntries(pid,scope,forModel=true,limit=100)
          for(j in 0 until entries.length()){
            val item=entries.getJSONObject(j)
            val combined=(item.optString("title")+" "+item.optString("description")+" "+item.optString("text")).lowercase()
            if(query !in combined && query !in metadata)continue
            matches.put(JSONObject().put("partitionId",pid).put("partitionTitle",partition.optString("title"))
              .put("importance",partition.optString("importance"))
              .put("id",item.getString("id")).put("kind",item.getString("kind"))
              .put("title",item.optString("title")).put("text",item.optString("text").take(4000)))
            if(matches.length()>=30)break
          }
          if(matches.length()>=30)break
        }
        JSONObject().put("ok",true).put("results",matches).put("limit",30)
      }
      "write" -> {
        val action=request.optString("action")
        require(action in listOf("create","update","delete")){"Invalid action"}
        val partition=request.optString("partitionId")
        require(partition in readableIds()){"Partition denied"}
        val title=request.optString("title")
        val body=request.optString("text")
        val entry=request.optString("entryId")
        if(action!="delete")require(title.length in 1..180 && body.isNotBlank() &&
          body.toByteArray(Charsets.UTF_8).size<=DshDatabaseStore.MAX_TEXT_BYTES)
        if(action!="create")require(entry.length in 4..128)
        if(confirm(action,partition,title,body,entry))JSONObject().put("ok",true).put("action",action)
          else JSONObject().put("ok",false).put("error","User refused or confirmation timed out")
      }
      else -> throw IllegalArgumentException("Unsupported database operation")
    }
  }
  private fun confirm(action:String,partition:String,title:String,body:String,entry:String):Boolean {
    val latch=CountDownLatch(1)
    val accepted=AtomicBoolean(false)
    val deadline=SystemClock.elapsedRealtime()+45000L
    ui.post {
      if(!alive.get()||activity.isFinishing||activity.isDestroyed){latch.countDown();return@post}
      val operation=when(action){"create"->"新增";"update"->"修改";else->"删除"}
      val preview=if(action=="delete")"条目 ID："+entry else body.take(500)
      val dialog=AlertDialog.Builder(activity).setTitle("模型请求"+operation+"数据库数据")
        .setMessage("分区："+partition+"\n标题："+title+"\n内容："+preview+
          "\n\n此操作必须由用户逐次确认。")
        .setNegativeButton("拒绝",null).setPositiveButton("允许本次",null).create()
      dialog.setOnShowListener {
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
          if(SystemClock.elapsedRealtime()<=deadline && alive.get() && enabled()) {
            try {
              // Do not trust a model-supplied approval boolean.
              if(action=="create")store.upsertText(partition,title,body,
                DshDatabaseStore.WriteAuthorization.fromConfirmedUserAction("entry:write:"+partition))
              if(action=="update")store.upsertText(partition,title,body,
                DshDatabaseStore.WriteAuthorization.fromConfirmedUserAction("entry:write:"+partition),entry)
              if(action=="delete")store.deleteEntry(partition,entry,
                DshDatabaseStore.WriteAuthorization.fromConfirmedUserAction("entry:delete:"+partition))
              accepted.set(true)
            }catch(_:Throwable){}
          }
          dialog.dismiss()
        }
      }
      dialog.setOnDismissListener{latch.countDown()}
      dialog.show()
      ui.postDelayed({if(dialog.isShowing)dialog.dismiss()},45000)
    }
    latch.await(46,TimeUnit.SECONDS)
    return accepted.get()
  }
  companion object{
    @Volatile private var running:DshDatabaseBroker?=null
    @Synchronized fun attach(activity:Activity):DshDatabaseBroker{
      running?.stop()
      return DshDatabaseBroker(activity).also{running=it;it.start()}
    }
    @Synchronized fun detach(){running?.stop();running=null}
    fun writeEndpoint(context:Context) {
      val endpoint=endpoint() ?: return
      val file=java.io.File(context.filesDir,"database-broker-endpoint.json")
      val tmp=java.io.File(context.filesDir,".database-broker-endpoint.tmp")
      tmp.writeText(JSONObject().put("port",endpoint.first).put("token",endpoint.second).toString())
      tmp.setReadable(false,false)
      tmp.setReadable(true,true)
      if(!tmp.renameTo(file))throw java.io.IOException("Cannot publish database broker endpoint")
    }
    fun deleteEndpoint(context:Context) {
      java.io.File(context.filesDir,"database-broker-endpoint.json").delete()
    }

    fun endpoint():Pair<Int,String>?=running?.takeIf{it.alive.get()}?.let{it.port to it.token}
    fun activeSession(value:String?){running?.setCurrentSession(value)}
  }
}
